-- Provisional AI catalogue, durable booking requests, and prepaid tenant credit metering.
-- No browser action grants paid access. Fulfillment is restricted to a separate billing role.
create table ai_credit_accounts (
 workspace_id uuid primary key references workspaces(id),plan_id text not null default 'included' check(plan_id in('included','ai_plus','ai_pro')),
 paid_through timestamptz,cancel_at_period_end boolean not null default false,updated_at timestamptz not null default now()
);
create table ai_credit_buckets (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references workspaces(id),kind text not null check(kind in('monthly','topup')),
 grant_key text not null,granted integer not null check(granted between 0 and 1000000),spent integer not null default 0 check(spent>=0),reserved integer not null default 0 check(reserved>=0),
 expires_at timestamptz,created_at timestamptz not null default now(),unique(workspace_id,grant_key),unique(workspace_id,id)
);
create table ai_credit_reservations (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,request_id uuid not null,actor_id uuid not null,operation text not null,
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object' and octet_length(metadata::text)<=4096),reserved_credits integer not null check(reserved_credits>0),actual_credits integer,
 status text not null default 'reserved' check(status in('reserved','succeeded','failed')),allocations jsonb not null check(jsonb_typeof(allocations)='array'),
 created_at timestamptz not null default now(),settled_at timestamptz,unique(workspace_id,request_id),unique(workspace_id,id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 check((status='reserved' and actual_credits is null and settled_at is null) or(status<>'reserved' and actual_credits between 0 and reserved_credits and settled_at is not null)),
 check(status<>'failed' or actual_credits=0)
);
create table ai_billing_requests (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,request_id uuid not null,actor_id uuid not null,
 kind text not null check(kind in('plan','topup','website')),item_id text not null,amount_cents integer check(amount_cents>=0),catalog_version text not null,
 request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),status text not null default 'pending' check(status in('pending','fulfilled','cancelled')),
 notes text check(length(notes)<=2000),requested_services jsonb not null default '[]' check(jsonb_typeof(requested_services)='array'),
 created_at timestamptz not null default now(),fulfilled_at timestamptz,unique(workspace_id,request_id),unique(workspace_id,id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),check((kind='website' and amount_cents is null) or(kind<>'website' and amount_cents is not null))
);
create table ai_billing_fulfillments (
 order_reference text primary key check(length(order_reference) between 3 and 200),request_id uuid not null unique references ai_billing_requests(id),workspace_id uuid not null references workspaces(id),
 event_digest text not null check(event_digest~'^[a-f0-9]{64}$'),paid_through timestamptz,operator_role text not null default session_user,created_at timestamptz not null default now()
);
create table ai_credit_reconciliations (
 reference text primary key check(length(reference) between 3 and 200),reservation_id uuid not null unique references ai_credit_reservations(id),workspace_id uuid not null references workspaces(id),
 event_digest text not null check(event_digest~'^[a-f0-9]{64}$'),actual_credits integer not null check(actual_credits>=0),status text not null check(status in('succeeded','failed')),operator_role text not null default session_user,created_at timestamptz not null default now()
);
create table ai_booking_status_events (
 id uuid primary key default gen_random_uuid(),request_id uuid not null references ai_billing_requests(id),workspace_id uuid not null references workspaces(id),
 status text not null check(status in('fulfilled','cancelled')),operator_role text not null default session_user,created_at timestamptz not null default now()
);
create index ai_credit_buckets_available on ai_credit_buckets(workspace_id,expires_at,created_at);
create index ai_billing_requests_recent on ai_billing_requests(workspace_id,created_at desc);

create function crm_ai_can_book(w uuid) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select w=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(select 1 from workspace_users u where u.workspace_id=w and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.status='active' and u.role='owner' and u.product_role in('customer_owner','workspace_admin','platform_admin','novalureGrowth','novalureAdmin'))
$$;
create function crm_ai_assert_actor(w uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid:=nullif(current_setting('app.actor_id',true),'')::uuid;member record;begin
 if w is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid or a is null then raise exception using errcode='42501',message='AI_BILLING_FORBIDDEN';end if;
 select * into member from crm_lock_active_member(w,a);
 if not found or member.product_role in('viewer','external_partner') then raise exception using errcode='42501',message='AI_BILLING_FORBIDDEN';end if;return a;
end $$;
create function crm_ai_refresh(w uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare account ai_credit_accounts;start_at timestamptz:=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';end_at timestamptz:=(date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC';quota integer;begin
 perform pg_advisory_xact_lock(hashtextextended('ai-credits:'||w::text,0));
 insert into ai_credit_accounts(workspace_id) values(w) on conflict do nothing;select * into account from ai_credit_accounts where workspace_id=w for update;
 quota:=case when account.paid_through>clock_timestamp() then case account.plan_id when 'ai_plus' then 21000 when 'ai_pro' then 51000 else 1000 end else 1000 end;
 insert into ai_credit_buckets(workspace_id,kind,grant_key,granted,expires_at) values(w,'monthly','month:'||to_char(start_at at time zone 'UTC','YYYY-MM'),quota,end_at)
 on conflict(workspace_id,grant_key) do update set granted=excluded.granted;
end $$;
create function crm_ai_snapshot(w uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid;account ai_credit_accounts;month_bucket ai_credit_buckets;start_at timestamptz:=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';end_at timestamptz:=(date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC';topups integer;pending integer;used integer;bookings jsonb;can_buy boolean;begin
 a:=crm_ai_assert_actor(w);perform crm_ai_refresh(w);select * into account from ai_credit_accounts where workspace_id=w;
 select * into month_bucket from ai_credit_buckets where workspace_id=w and grant_key='month:'||to_char(start_at at time zone 'UTC','YYYY-MM');
 select coalesce(sum(greatest(0,granted-spent-reserved)),0)::integer into topups from ai_credit_buckets where workspace_id=w and kind='topup' and(expires_at is null or expires_at>clock_timestamp());
 select coalesce(sum(reserved_credits),0)::integer into pending from ai_credit_reservations where workspace_id=w and status='reserved';can_buy:=crm_ai_can_book(w);
 select coalesce(sum(actual_credits),0)::integer into used from ai_credit_reservations where workspace_id=w and status='succeeded' and created_at>=start_at and created_at<end_at;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'requestId',r.request_id,'kind',r.kind,'itemId',r.item_id,'status',r.status,'amountCents',r.amount_cents,'catalogVersion',r.catalog_version,'createdAt',r.created_at,'fulfilledAt',r.fulfilled_at,'notes',r.notes,'requestedServices',r.requested_services) order by r.created_at desc),'[]'::jsonb) into bookings from(select * from ai_billing_requests where workspace_id=w and(can_buy or(kind='website' and actor_id=a)) order by created_at desc limit 25)r;
 return jsonb_build_object('source','database','planId',case when account.paid_through>clock_timestamp() then account.plan_id else 'included' end,'paidThrough',account.paid_through,'cancelAtPeriodEnd',account.cancel_at_period_end,
 'periodStart',start_at,'periodEnd',end_at,'monthlyCredits',month_bucket.granted,'monthlyRemaining',greatest(0,month_bucket.granted-month_bucket.spent-month_bucket.reserved),'topupRemaining',topups,
 'availableCredits',greatest(0,month_bucket.granted-month_bucket.spent-month_bucket.reserved)+topups,'reservedCredits',pending,'usedCredits',used,'canBook',can_buy,'canRequestWebsite',true,'bookings',bookings);
end $$;
create function crm_ai_reserve(w uuid,p_request uuid,p_operation text,p_credits integer,p_hash text,p_metadata jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid;prior ai_credit_reservations;bucket ai_credit_buckets;available integer;leftover integer:=p_credits;amount integer;allocations jsonb:='[]';reservation uuid:=gen_random_uuid();begin
 a:=crm_ai_assert_actor(w);if p_credits is null or p_credits not between 1 and 100000 or p_operation!~'^[a-z][a-z0-9_.:-]{2,119}$' or p_hash!~'^[a-f0-9]{64}$' then raise exception using errcode='23514',message='AI_RESERVATION_INVALID';end if;
 if p_metadata is null or jsonb_typeof(p_metadata)<>'object' or octet_length(p_metadata::text)>4096 or exists(select 1 from jsonb_object_keys(p_metadata) k where k not in('model','meterVersion','requestHash','inputTokenBound','maxOutputTokens')) then raise exception using errcode='23514',message='AI_RESERVATION_INVALID';end if;
 if exists(select 1 from workspace_module_settings where workspace_id=w and module_key='bots' and not enabled) then raise exception using errcode='42501',message='AI_MODULE_DISABLED';end if;
 perform crm_ai_refresh(w);select * into prior from ai_credit_reservations where workspace_id=w and request_id=p_request;
 if found then if prior.request_hash<>p_hash or prior.actor_id<>a or prior.operation<>p_operation or prior.reserved_credits<>p_credits then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT';end if;
 return jsonb_build_object('reservationId',prior.id,'requestId',prior.request_id,'reservedCredits',prior.reserved_credits,'status',prior.status,'replayed',true);end if;
 select coalesce(sum(greatest(0,granted-spent-reserved)),0)::integer into available from ai_credit_buckets where workspace_id=w and(expires_at is null or expires_at>clock_timestamp());
 if available<p_credits then raise exception using errcode='P0001',message='AI_CREDITS_EXHAUSTED';end if;
 for bucket in select * from ai_credit_buckets where workspace_id=w and(expires_at is null or expires_at>clock_timestamp()) and granted>spent+reserved order by expires_at nulls last,created_at,id for update loop
  amount:=least(leftover,bucket.granted-bucket.spent-bucket.reserved);update ai_credit_buckets set reserved=reserved+amount where id=bucket.id;allocations:=allocations||jsonb_build_array(jsonb_build_object('bucketId',bucket.id,'credits',amount));leftover:=leftover-amount;exit when leftover=0;
 end loop;
 if leftover<>0 then raise exception using errcode='P0001',message='AI_CREDITS_EXHAUSTED';end if;
 insert into ai_credit_reservations(id,workspace_id,request_id,actor_id,operation,request_hash,metadata,reserved_credits,allocations) values(reservation,w,p_request,a,p_operation,p_hash,p_metadata,p_credits,allocations);
 return jsonb_build_object('reservationId',reservation,'requestId',p_request,'reservedCredits',p_credits,'status','reserved','replayed',false);
end $$;
create function crm_ai_settle(w uuid,p_request uuid,p_actual integer,p_status text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid;reservation ai_credit_reservations;allocation jsonb;leftover integer:=p_actual;charged integer;begin
 a:=crm_ai_assert_actor(w);perform pg_advisory_xact_lock(hashtextextended('ai-credits:'||w::text,0));select * into reservation from ai_credit_reservations where workspace_id=w and request_id=p_request for update;
 if not found or reservation.actor_id<>a then raise exception using errcode='42501',message='AI_RESERVATION_UNAVAILABLE';end if;
 if p_status not in('succeeded','failed') or p_actual is null or p_actual<0 or p_actual>reservation.reserved_credits or(p_status='failed' and p_actual<>0) then raise exception using errcode='23514',message='AI_SETTLEMENT_INVALID';end if;
 if reservation.status<>'reserved' then if reservation.status<>p_status or reservation.actual_credits<>p_actual then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('reservationId',reservation.id,'actualCredits',reservation.actual_credits,'status',reservation.status,'replayed',true);end if;
 for allocation in select * from jsonb_array_elements(reservation.allocations) loop
  charged:=least(leftover,(allocation->>'credits')::integer);update ai_credit_buckets set reserved=reserved-(allocation->>'credits')::integer,spent=spent+charged where workspace_id=w and id=(allocation->>'bucketId')::uuid;leftover:=leftover-charged;
 end loop;
 update ai_credit_reservations set actual_credits=p_actual,status=p_status,settled_at=clock_timestamp() where id=reservation.id;
 return jsonb_build_object('reservationId',reservation.id,'actualCredits',p_actual,'status',p_status,'replayed',false);
end $$;
create function crm_ai_request_booking(w uuid,p_request uuid,p_kind text,p_item text,p_version text,p_hash text,p_notes text,p_services jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid;prior ai_billing_requests;amount integer;request uuid:=gen_random_uuid();begin
 a:=crm_ai_assert_actor(w);if p_kind<>'website' and not crm_ai_can_book(w) then raise exception using errcode='42501',message='AI_BILLING_FORBIDDEN';end if;
 if p_version<>'2026-11-04-draft-v1' then raise exception using errcode='23514',message='AI_CATALOG_CHANGED';end if;
 if p_hash!~'^[a-f0-9]{64}$' or length(p_notes)>2000 or p_services is null or jsonb_typeof(p_services)<>'array' or jsonb_array_length(p_services)>4 or exists(select 1 from jsonb_array_elements(p_services)v where jsonb_typeof(v)<>'string' or v#>>'{}' not in('website_creation','hosting','maintenance','content_updates')) then raise exception using errcode='23514',message='AI_BOOKING_INVALID';end if;
 amount:=case when p_kind='plan' then case p_item when 'included' then 0 when 'ai_plus' then 9900 when 'ai_pro' then 19900 end when p_kind='topup' then case p_item when 'credits_5000' then 2900 when 'credits_20000' then 9900 end end;
 if(p_kind='website' and p_item<>'real_estate_website') or(p_kind<>'website' and amount is null) or(p_kind<>'website' and(p_notes is not null or p_services<>'[]'::jsonb)) then raise exception using errcode='23514',message='AI_BOOKING_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended('ai-booking:'||w::text||':'||p_request::text,0));select * into prior from ai_billing_requests where workspace_id=w and request_id=p_request;
 if found then if prior.request_hash<>p_hash or prior.actor_id<>a then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT';end if;return to_jsonb(prior);end if;
 insert into ai_billing_requests(id,workspace_id,request_id,actor_id,kind,item_id,amount_cents,catalog_version,request_hash,notes,requested_services) values(request,w,p_request,a,p_kind,p_item,amount,p_version,p_hash,p_notes,p_services) returning * into prior;return to_jsonb(prior);
end $$;

-- Trusted fulfillment is deliberately unavailable to the customer runtime role.
do $$begin if not exists(select 1 from pg_roles where rolname='novalure_ai_billing_writer') then create role novalure_ai_billing_writer nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;end $$;
create function crm_ai_fulfill_booking(p_request uuid,p_order text,p_digest text,p_paid_through timestamptz default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare request ai_billing_requests;prior ai_billing_fulfillments;account ai_credit_accounts;credits integer;begin
 if p_order is null or length(p_order) not between 3 and 200 or p_digest!~'^[a-f0-9]{64}$' then raise exception using errcode='23514',message='AI_FULFILLMENT_INVALID';end if;
 select * into request from ai_billing_requests where id=p_request;if not found or request.kind='website' then raise exception using errcode='23514',message='AI_FULFILLMENT_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended('ai-credits:'||request.workspace_id::text,0));perform pg_advisory_xact_lock(hashtextextended('ai-paid-order:'||p_order,0));select * into prior from ai_billing_fulfillments where order_reference=p_order;
 if found then if prior.request_id<>p_request or prior.event_digest<>p_digest or prior.paid_through is distinct from p_paid_through then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('status','fulfilled','replayed',true);end if;
 select * into request from ai_billing_requests where id=p_request for update;if request.status<>'pending' then raise exception using errcode='23514',message='AI_BOOKING_NOT_PENDING';end if;
 -- V1 subscriptions use explicitly confirmed UTC calendar months. A rolling
 -- date spanning two months must never buy two complete monthly allowances.
 if request.kind='plan' and request.item_id<>'included' and(p_paid_through is null or p_paid_through<=clock_timestamp() or p_paid_through>clock_timestamp()+interval '2 years' or p_paid_through is distinct from(date_trunc('month',p_paid_through at time zone 'UTC') at time zone 'UTC')) then raise exception using errcode='23514',message='AI_PAID_PERIOD_INVALID';end if;
 perform crm_ai_refresh(request.workspace_id);
 select * into account from ai_credit_accounts where workspace_id=request.workspace_id for update;
 if request.kind='plan' and request.item_id<>'included' and account.paid_through>clock_timestamp() then
  if p_paid_through<account.paid_through then raise exception using errcode='23514',message='AI_PAID_PERIOD_REGRESSION';end if;
  if account.plan_id='ai_pro' and request.item_id='ai_plus' then raise exception using errcode='23514',message='AI_DOWNGRADE_REQUIRES_PERIOD_END';end if;
 end if;
 if request.kind='plan' then
  if request.item_id='included' then update ai_credit_accounts set cancel_at_period_end=true,updated_at=clock_timestamp() where workspace_id=request.workspace_id;
  else update ai_credit_accounts set plan_id=request.item_id,paid_through=p_paid_through,cancel_at_period_end=false,updated_at=clock_timestamp() where workspace_id=request.workspace_id;end if;
 else
  credits:=case request.item_id when 'credits_5000' then 5000 when 'credits_20000' then 20000 end;if credits is null then raise exception using errcode='23514',message='AI_FULFILLMENT_INVALID';end if;
  insert into ai_credit_buckets(workspace_id,kind,grant_key,granted) values(request.workspace_id,'topup','order:'||p_order,credits);
 end if;
 insert into ai_billing_fulfillments(order_reference,request_id,workspace_id,event_digest,paid_through) values(p_order,p_request,request.workspace_id,p_digest,p_paid_through);
 update ai_billing_requests set status='fulfilled',fulfilled_at=clock_timestamp() where id=p_request;perform crm_ai_refresh(request.workspace_id);
 return jsonb_build_object('status','fulfilled','replayed',false);
end $$;
-- Billing operators can close a service/quote request without creating AI credits.
create function crm_ai_close_booking(p_request uuid,p_status text) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare request ai_billing_requests;begin
 if p_status not in('fulfilled','cancelled') then raise exception using errcode='23514',message='AI_BOOKING_INVALID';end if;
 select * into request from ai_billing_requests where id=p_request for update;
 if found and request.status=p_status then return;end if;
 update ai_billing_requests set status=p_status,fulfilled_at=case when p_status='fulfilled' then clock_timestamp() else null end where id=p_request and status='pending' and(kind='website' or p_status='cancelled');
 if not found then raise exception using errcode='23514',message='AI_BOOKING_NOT_PENDING';end if;
 insert into ai_booking_status_events(request_id,workspace_id,status) values(p_request,request.workspace_id,p_status);
end $$;
create function crm_ai_reconcile_reservation(p_reservation uuid,p_actual integer,p_status text,p_reference text,p_digest text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare reservation ai_credit_reservations;prior ai_credit_reconciliations;allocation jsonb;leftover integer:=p_actual;charged integer;begin
 if p_reference is null or length(p_reference) not between 3 and 200 or p_digest is null or p_digest!~'^[a-f0-9]{64}$' then raise exception using errcode='23514',message='AI_RECONCILIATION_INVALID';end if;
 select * into reservation from ai_credit_reservations where id=p_reservation;if not found then raise exception using errcode='23514',message='AI_RESERVATION_UNAVAILABLE';end if;
 perform pg_advisory_xact_lock(hashtextextended('ai-credits:'||reservation.workspace_id::text,0));perform pg_advisory_xact_lock(hashtextextended('ai-reconcile:'||p_reference,0));
 select * into prior from ai_credit_reconciliations where reference=p_reference;
 if found then if prior.reservation_id<>p_reservation or prior.actual_credits<>p_actual or prior.status<>p_status or prior.event_digest<>p_digest then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('status',prior.status,'actualCredits',prior.actual_credits,'replayed',true);end if;
 select * into reservation from ai_credit_reservations where id=p_reservation for update;
 if p_status not in('succeeded','failed') or p_actual is null or p_actual<0 or p_actual>reservation.reserved_credits or(p_status='failed' and p_actual<>0) then raise exception using errcode='23514',message='AI_RECONCILIATION_INVALID';end if;
 if reservation.status<>'reserved' then if reservation.status<>p_status or reservation.actual_credits<>p_actual then raise exception using errcode='23505',message='IDEMPOTENCY_CONFLICT';end if;
 else
  for allocation in select * from jsonb_array_elements(reservation.allocations) loop
   charged:=least(leftover,(allocation->>'credits')::integer);update ai_credit_buckets set reserved=reserved-(allocation->>'credits')::integer,spent=spent+charged where workspace_id=reservation.workspace_id and id=(allocation->>'bucketId')::uuid;leftover:=leftover-charged;
  end loop;
  update ai_credit_reservations set actual_credits=p_actual,status=p_status,settled_at=clock_timestamp() where id=reservation.id;
 end if;
 insert into ai_credit_reconciliations(reference,reservation_id,workspace_id,event_digest,actual_credits,status) values(p_reference,p_reservation,reservation.workspace_id,p_digest,p_actual,p_status);
 return jsonb_build_object('status',p_status,'actualCredits',p_actual,'replayed',false);
end $$;
create function crm_ai_operator_requests(p_workspace uuid default null,p_status text default 'pending') returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;begin
 if p_status is not null and p_status not in('pending','fulfilled','cancelled') then raise exception using errcode='23514',message='AI_BOOKING_INVALID';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at),'[]'::jsonb) into result from(select b.id,b.workspace_id as "workspaceId",b.request_id as "requestId",b.kind,b.item_id as "itemId",b.status,b.amount_cents as "amountCents",b.catalog_version as "catalogVersion",b.notes,b.requested_services as "requestedServices",b.created_at,b.fulfilled_at as "fulfilledAt",u.name as "requesterName",u.email as "requesterEmail" from ai_billing_requests b join workspace_users u on u.workspace_id=b.workspace_id and u.id=b.actor_id where(p_workspace is null or b.workspace_id=p_workspace) and(p_status is null or b.status=p_status) order by b.created_at,b.id limit 100)r;
 return result;
end $$;
create function crm_ai_operator_reservations(p_workspace uuid default null) returns jsonb language sql security definer set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at),'[]'::jsonb) from(select id,workspace_id as "workspaceId",request_id as "requestId",actor_id as "actorId",operation,reserved_credits as "reservedCredits",metadata,created_at from ai_credit_reservations where status='reserved' and(p_workspace is null or workspace_id=p_workspace) order by created_at,id limit 100)r
$$;

do $$declare relation text;begin
 foreach relation in array array['ai_credit_accounts','ai_credit_buckets','ai_credit_reservations','ai_billing_requests','ai_billing_fulfillments','ai_credit_reconciliations','ai_booking_status_events'] loop
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('revoke all on %I from public,novalure_tenant_app',relation);
  execute format('create policy ai_credit_owner on %I to %I using(true) with check(true)',relation,current_user);
 end loop;
end $$;
create policy ai_account_read on ai_credit_accounts for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_workspace_manager(workspace_id));
create policy ai_bucket_read on ai_credit_buckets for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_workspace_manager(workspace_id));
create policy ai_reservation_read on ai_credit_reservations for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and(actor_id=nullif(current_setting('app.actor_id',true),'')::uuid or crm_ai_can_book(workspace_id)));
create policy ai_request_read on ai_billing_requests for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and(crm_ai_can_book(workspace_id) or(kind='website' and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid)));
grant select on ai_credit_accounts,ai_credit_buckets,ai_credit_reservations,ai_billing_requests to novalure_tenant_app;
revoke all on function crm_ai_can_book(uuid),crm_ai_assert_actor(uuid),crm_ai_refresh(uuid),crm_ai_snapshot(uuid),crm_ai_reserve(uuid,uuid,text,integer,text,jsonb),crm_ai_settle(uuid,uuid,integer,text),crm_ai_request_booking(uuid,uuid,text,text,text,text,text,jsonb),crm_ai_fulfill_booking(uuid,text,text,timestamptz),crm_ai_close_booking(uuid,text),crm_ai_reconcile_reservation(uuid,integer,text,text,text),crm_ai_operator_requests(uuid,text),crm_ai_operator_reservations(uuid) from public,novalure_tenant_app;
grant execute on function crm_ai_can_book(uuid),crm_ai_snapshot(uuid),crm_ai_reserve(uuid,uuid,text,integer,text,jsonb),crm_ai_settle(uuid,uuid,integer,text),crm_ai_request_booking(uuid,uuid,text,text,text,text,text,jsonb) to novalure_tenant_app;
grant usage on schema public to novalure_ai_billing_writer;
grant execute on function crm_ai_fulfill_booking(uuid,text,text,timestamptz),crm_ai_close_booking(uuid,text),crm_ai_reconcile_reservation(uuid,integer,text,text,text),crm_ai_operator_requests(uuid,text),crm_ai_operator_reservations(uuid) to novalure_ai_billing_writer;
