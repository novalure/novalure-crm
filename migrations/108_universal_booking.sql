-- Package 5: additive booking core. No module/contract is enabled by this migration.
set local lock_timeout = '5s';
set local statement_timeout = '14min';
-- General companies are a customer classification, never a permission or entitlement.
alter table public.workspaces drop constraint workspaces_customer_type_check;
alter table public.workspaces add constraint workspaces_customer_type_check check(customer_type in ('real_estate_broker','property_developer','hybrid_real_estate','novalure_internal','general_company'));
alter table public.projects drop constraint projects_customer_type_check;
alter table public.projects add constraint projects_customer_type_check check(customer_type is null or customer_type in ('real_estate_broker','property_developer','hybrid_real_estate','novalure_internal','general_company'));
create table public.booking_calendar_connections (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 user_id uuid not null, provider text not null check(provider in ('microsoft','google')),
 status text not null default 'disconnected' check(status in ('connected','disconnected','reauth_required')),
 account_id text,account_label text,encrypted_tokens text,expires_at timestamptz,scopes text[] not null default '{}',
 calendars jsonb not null default '[]' check(jsonb_typeof(calendars)='array'),write_calendar_id text,
 conflict_calendar_ids text[] not null default '{}',error_code text,revision bigint not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,user_id,provider),unique(workspace_id,id),unique(workspace_id,user_id,id),
 foreign key(workspace_id,user_id) references public.workspace_users(workspace_id,id)
);
-- Bounded v1: a physical provider organizer/account and selected writer have one owner.
-- Conflict-only calendars can be shared; no foreign tenant identity is exposed by the API.
create unique index booking_one_organizer_account on public.booking_calendar_connections(provider,account_id)
 where account_id is not null and write_calendar_id is not null;
create unique index booking_one_writer_calendar on public.booking_calendar_connections(provider,write_calendar_id)
 where write_calendar_id is not null;
create table public.booking_rule_sets (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 user_id uuid,kind text not null default '*' check(kind in ('*','phone','teams','meet','office','onsite')),
 rules jsonb not null default '{}' check(jsonb_typeof(rules)='object'),revision bigint not null default 1,
 updated_at timestamptz not null default now(),unique nulls not distinct(workspace_id,user_id,kind),
 foreign key(workspace_id,user_id) references public.workspace_users(workspace_id,id)
);
create table public.booking_reservations (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),organizer_id uuid not null,
 provider text not null check(provider in ('microsoft','google')),kind text not null check(kind in ('phone','teams','meet','office','onsite')),
 connection_id uuid not null,connection_revision bigint not null,calendar_id text not null,title text not null,
 starts_at timestamptz not null,ends_at timestamptz not null,blocked_starts_at timestamptz not null,blocked_ends_at timestamptz not null,
 state text not null check(state in ('held','expired','processing','confirmed','uncertain','cancelled','conflict')),
 expires_at timestamptz not null,rules jsonb not null,request_hash text not null,idempotency_key uuid not null,
 provider_event_id text,provider_etag text,video_url text,video_status text not null default 'none',
 operation_id uuid,operation_kind text check(operation_kind in ('create','reschedule','cancel')),operation_target jsonb,
 notification_status text not null default 'not_requested' check(notification_status in ('not_requested','pending','sent','failed')),
 revision bigint not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,organizer_id,idempotency_key),
 foreign key(workspace_id,organizer_id) references public.workspace_users(workspace_id,id),
 foreign key(workspace_id,organizer_id,connection_id) references public.booking_calendar_connections(workspace_id,user_id,id),
 check(ends_at>starts_at and blocked_starts_at<=starts_at and blocked_ends_at>=ends_at)
);
create index booking_resource_active on public.booking_reservations(workspace_id,organizer_id,blocked_starts_at,blocked_ends_at)
 where state in ('held','processing','confirmed','uncertain','conflict');
create table public.booking_operations (
 id uuid primary key,workspace_id uuid not null,booking_id uuid not null,organizer_id uuid not null,
 kind text not null check(kind in ('create','reschedule','cancel')),idempotency_key uuid not null,request_hash text not null,
 state text not null check(state in ('processing','succeeded','uncertain','rejected')),error_code text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,organizer_id,idempotency_key),foreign key(workspace_id,booking_id) references public.booking_reservations(workspace_id,id),
 foreign key(workspace_id,organizer_id) references public.workspace_users(workspace_id,id)
);
create function public.booking_actor_allowed(p_workspace uuid,p_user uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid
 and p_user=nullif(current_setting('app.actor_id',true),'')::uuid
 and exists(select 1 from public.workspace_users u where u.id=p_user and u.workspace_id=p_workspace and u.status='active'
 and u.role in ('owner','admin','agent') and u.product_role not in ('viewer','external_partner'))
 and exists(select 1 from public.workspace_module_settings m where m.workspace_id=p_workspace and m.module_key='calendar' and m.enabled)
$$;
revoke all on function public.booking_actor_allowed(uuid,uuid) from public;
grant execute on function public.booking_actor_allowed(uuid,uuid) to novalure_tenant_app;
alter table public.booking_calendar_connections enable row level security;
alter table public.booking_calendar_connections force row level security;
alter table public.booking_rule_sets enable row level security;
alter table public.booking_rule_sets force row level security;
alter table public.booking_reservations enable row level security;
alter table public.booking_reservations force row level security;
alter table public.booking_operations enable row level security;
alter table public.booking_operations force row level security;
create policy booking_connections_actor on public.booking_calendar_connections for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,user_id)) with check(public.booking_actor_allowed(workspace_id,user_id));
create policy booking_reservations_actor on public.booking_reservations for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,organizer_id)) with check(public.booking_actor_allowed(workspace_id,organizer_id));
create policy booking_operations_actor on public.booking_operations for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,organizer_id)) with check(public.booking_actor_allowed(workspace_id,organizer_id));
create policy booking_rules_read on public.booking_rule_sets for select to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid) and (user_id is null or user_id=nullif(current_setting('app.actor_id',true),'')::uuid));
create policy booking_rules_write on public.booking_rule_sets for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,coalesce(user_id,nullif(current_setting('app.actor_id',true),'')::uuid)) and (user_id is not null or public.crm_workspace_manager(workspace_id)))
 with check(public.booking_actor_allowed(workspace_id,coalesce(user_id,nullif(current_setting('app.actor_id',true),'')::uuid)) and (user_id is not null or public.crm_workspace_manager(workspace_id)));
revoke all on public.booking_calendar_connections,public.booking_rule_sets,public.booking_reservations,public.booking_operations from public,novalure_app,novalure_tenant_app;
grant select,insert,update on public.booking_calendar_connections,public.booking_rule_sets,public.booking_reservations,public.booking_operations to novalure_tenant_app;
-- A separate state ledger preserves existing meeting OAuth behavior.
create table public.booking_oauth_authorization_states (like public.oauth_authorization_states including defaults including constraints including indexes);
alter table public.booking_oauth_authorization_states add foreign key(workspace_id) references public.workspaces(id);
alter table public.booking_oauth_authorization_states add foreign key(workspace_id,user_id) references public.workspace_users(workspace_id,id);
alter table public.booking_oauth_authorization_states enable row level security;
alter table public.booking_oauth_authorization_states force row level security;
create policy booking_oauth_self on public.booking_oauth_authorization_states for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,user_id)) with check(public.booking_actor_allowed(workspace_id,user_id));
revoke all on public.booking_oauth_authorization_states from public,novalure_app,novalure_tenant_app;
grant select,insert,update on public.booking_oauth_authorization_states to novalure_tenant_app;
alter table public.booking_reservations add column crm_booking_id uuid references public.meeting_bookings(id);
-- Bounded bridge into the existing authoritative CRM appointment object.
-- No direct new privilege on meeting_bookings is granted to the runtime.
create function public.booking_sync_crm(p_id uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare b record; actor record; target_status text;
begin
 select * into b from public.booking_reservations where id=p_id for update;
 if not found or not public.booking_actor_allowed(b.workspace_id,b.organizer_id) then raise exception using errcode='42501',message='Booking denied'; end if;
 if b.state not in ('confirmed','cancelled','conflict') then return b.crm_booking_id; end if;
 select name,email into actor from public.workspace_users where id=b.organizer_id and workspace_id=b.workspace_id;
 target_status:=case when b.state='cancelled' then 'cancelled' when b.state='conflict' then 'requested' else 'confirmed' end;
 if b.crm_booking_id is null then
  insert into public.meeting_bookings(id,workspace_id,slug,title,contact_name,contact_email,starts_at,ends_at,calendar_provider,meeting_provider,status,source,metadata)
   values(b.id,b.workspace_id,'universal-booking',b.title,actor.name,actor.email,b.starts_at,b.ends_at,b.provider,
    case b.kind when 'teams' then 'microsoft-teams' when 'meet' then 'google-meet' else 'manual-link' end,target_status,'universal_booking',
    jsonb_build_object('universalBookingId',b.id,'bookingState',b.state,'organizerId',b.organizer_id,'providerEventId',b.provider_event_id,'onlineMeetingUrl',b.video_url,'videoStatus',b.video_status,'notificationStatus',b.notification_status));
  update public.booking_reservations set crm_booking_id=b.id where id=b.id;
 else
  update public.meeting_bookings set title=b.title,starts_at=b.starts_at,ends_at=b.ends_at,status=target_status,updated_at=now(),
   metadata=metadata||jsonb_build_object('bookingState',b.state,'providerEventId',b.provider_event_id,'onlineMeetingUrl',b.video_url,'videoStatus',b.video_status,'notificationStatus',b.notification_status)
   where id=b.crm_booking_id and workspace_id=b.workspace_id and metadata->>'universalBookingId'=b.id::text;
  if not found then raise exception using errcode='42501',message='Booking CRM mapping denied'; end if;
 end if;
 return b.id;
end $$;
create function public.booking_capture_request(p_id uuid,p_workspace uuid,p_title text,p_start timestamptz,p_kind text,p_provider text,p_note text) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor record;
begin
 if not public.booking_actor_allowed(p_workspace,nullif(current_setting('app.actor_id',true),'')::uuid) then raise exception using errcode='42501',message='Booking denied'; end if;
 if length(p_title) not between 1 and 200 or p_start is null or p_kind not in ('phone','teams','meet','office','onsite') or p_provider not in ('microsoft','google') or length(coalesce(p_note,''))>2000 then raise exception using errcode='22023',message='Invalid request'; end if;
 select id,name,email into actor from public.workspace_users where id=nullif(current_setting('app.actor_id',true),'')::uuid and workspace_id=p_workspace;
 insert into public.meeting_bookings(id,workspace_id,slug,title,contact_name,contact_email,contact_note,starts_at,ends_at,calendar_provider,meeting_provider,status,source,metadata)
 values(p_id,p_workspace,'universal-booking-request',p_title,actor.name,actor.email,coalesce(p_note,''),p_start,p_start+interval '30 minutes','none','manual-link','requested','universal_booking',
 jsonb_build_object('requestOnly',true,'organizerId',actor.id,'requestedKind',p_kind,'requestedProvider',p_provider,'providerCreated',false,'notificationStatus','not_requested'))
 on conflict(id) do nothing;
 if not exists(select 1 from public.meeting_bookings where id=p_id and workspace_id=p_workspace and source='universal_booking' and metadata->>'organizerId'=actor.id::text and metadata->>'requestOnly'='true' and title=p_title and starts_at=p_start and contact_note=coalesce(p_note,'') and metadata->>'requestedKind'=p_kind and metadata->>'requestedProvider'=p_provider) then raise exception using errcode='42501',message='Request mapping denied'; end if;
 return p_id;
end $$;
revoke all on function public.booking_sync_crm(uuid),public.booking_capture_request(uuid,uuid,text,timestamptz,text,text,text) from public;
grant execute on function public.booking_sync_crm(uuid),public.booking_capture_request(uuid,uuid,text,timestamptz,text,text,text) to novalure_tenant_app;
