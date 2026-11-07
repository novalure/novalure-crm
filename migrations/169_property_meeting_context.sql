-- A public booking can propose a viewing of an offered unit; only documented staff review links a CRM lead.
create unique index if not exists meeting_pages_workspace_id_idx on meeting_pages(workspace_id,id);
create unique index if not exists meeting_bookings_workspace_id_idx on meeting_bookings(workspace_id,id);
create unique index if not exists property_viewings_workspace_id_idx on property_viewing_slots(workspace_id,id);
create table property_booking_offers(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,project_id uuid not null,property_id uuid not null,unit_id uuid not null,meeting_page_id uuid not null,
 enabled boolean not null default true,configured_by uuid not null,version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',unique(workspace_id,id),unique(workspace_id,property_id,unit_id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,property_id) references seller_listings(workspace_id,id),foreign key(workspace_id,project_id,unit_id) references property_units(workspace_id,project_id,id),foreign key(workspace_id,meeting_page_id) references meeting_pages(workspace_id,id),foreign key(workspace_id,configured_by) references workspace_users(workspace_id,id)
);
create table property_meeting_bookings(
 booking_id uuid primary key,workspace_id uuid not null,project_id uuid not null,property_id uuid not null,unit_id uuid not null,offer_id uuid not null,expose_link_id uuid not null,
 lead_id uuid,viewing_id uuid,status text not null default 'unverified' check(status in('unverified','confirmed','needs_review','cancelled')),review_reason text,reviewed_by uuid,reviewed_at timestamptz,version integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 data_classification text not null default 'UNCLASSIFIED',data_purpose text not null default 'crm_sales',unique(workspace_id,booking_id),
 foreign key(workspace_id,booking_id) references meeting_bookings(workspace_id,id),foreign key(workspace_id,offer_id) references property_booking_offers(workspace_id,id),foreign key(workspace_id,expose_link_id) references web_expose_links(workspace_id,id),foreign key(workspace_id,project_id,lead_id) references leads(workspace_id,project_id,id),foreign key(workspace_id,viewing_id) references property_viewing_slots(workspace_id,id),foreign key(workspace_id,reviewed_by) references workspace_users(workspace_id,id)
);
create function crm_property_booking_staff_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_table_name='property_booking_offers' then
  if tg_op='UPDATE' and (new.workspace_id,new.project_id,new.property_id,new.unit_id) is distinct from (old.workspace_id,old.project_id,old.property_id,old.unit_id) then raise exception using errcode='23514',message='Booking offer scope is immutable';end if;
  if not exists(select 1 from seller_listings p join property_units u on u.workspace_id=p.workspace_id and u.project_id=p.project_id and u.id=new.unit_id join meeting_pages m on m.id=new.meeting_page_id and m.workspace_id=p.workspace_id and m.project_id=p.project_id where p.workspace_id=new.workspace_id and p.id=new.property_id and p.project_id=new.project_id and (u.metadata->>'sellerListingId'=p.id::text or p.unit_id=u.id) and coalesce(p.canonical_payload#>>'{onboardingExample,synthetic}','false')<>'true' and m.status='active') then raise exception using errcode='23514',message='Meeting page, property and unit require the same real project';end if;
  if new.configured_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='42501',message='Real configuring actor required';end if;
 else
  if pg_trigger_depth()>1 and current_user=pg_get_userbyid((select proowner from pg_proc where oid='public.crm_property_booking_source()'::regprocedure)) then return new;end if;
  if tg_op<>'UPDATE' or (to_jsonb(new)-array['lead_id','viewing_id','status','review_reason','reviewed_by','reviewed_at','version','updated_at']) is distinct from (to_jsonb(old)-array['lead_id','viewing_id','status','review_reason','reviewed_by','reviewed_at','version','updated_at']) or old.status='cancelled' or new.status<>'confirmed' or new.version<>old.version+1 or length(coalesce(new.review_reason,''))<10 or new.reviewed_by is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='23514',message='Documented authorized viewing confirmation required';end if;
  if old.lead_id is not null and new.lead_id is distinct from old.lead_id then raise exception using errcode='23514',message='Confirmed participant cannot be replaced';end if;
  if not exists(select 1 from property_viewing_slots v join leads l on l.workspace_id=v.workspace_id and l.id=v.lead_id where v.workspace_id=new.workspace_id and v.id=new.viewing_id and v.project_id=new.project_id and v.unit_id=new.unit_id and v.lead_id=new.lead_id and v.status='confirmed' and coalesce(l.metadata#>>'{onboardingExample,synthetic}','false')<>'true') then raise exception using errcode='23514',message='Matching authoritative confirmed viewing required';end if;
 end if;return new;
end $$;
do $$ declare t text;begin foreach t in array array['property_booking_offers','property_meeting_bookings'] loop
 execute format('alter table %I enable row level security',t);execute format('alter table %I force row level security',t);
 execute format('create trigger sales_classification before insert or update on %I for each row execute function crm_set_sales_classification()',t);
 execute format('create policy property_booking_read on %I for select to novalure_tenant_app using(crm_web_expose_access(workspace_id,property_id,false) and crm_classification_allowed(workspace_id,data_classification,data_purpose))',t);
 execute format('create policy property_booking_write on %I for all to novalure_tenant_app using(crm_web_expose_access(workspace_id,property_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(crm_web_expose_access(workspace_id,property_id,true) and crm_classification_allowed(workspace_id,data_classification,data_purpose))',t);
 execute format('create policy property_booking_owner on %I using(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass))) with check(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)))',t,'public.'||t,'public.'||t);
 execute format('create trigger property_booking_staff_guard before insert or update on %I for each row execute function crm_property_booking_staff_guard()',t);
 execute format('grant select,update on %I to novalure_tenant_app',t);
end loop;end $$;
grant insert on property_booking_offers to novalure_tenant_app;
-- The trigger owner may only propagate changes of its bound booking. No tenant/actor GUC is adopted.
do $$ begin
 execute format('create policy property_booking_page_owner on meeting_pages for select to %I using(true)',current_user);
 execute format('create policy property_booking_grants_owner on project_pipeline_permissions for select to %I using(true)',current_user);
 execute format('create policy property_booking_viewing_owner on property_viewing_slots to %I using(true) with check(true)',current_user);
 execute format('create policy property_booking_calendar_owner on calendar_events to %I using(true) with check(true)',current_user);
 execute format('create policy property_booking_calendar_sync_owner on calendar_sync_events for select to %I using(true)',current_user);
end $$;
create function crm_property_booking_context(p_hash text,p_offer uuid default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare lid uuid;result jsonb;begin
 if coalesce(p_hash,'')!~'^[a-f0-9]{64}$' then return null;end if;
 select id into lid from web_expose_links where token_hash=p_hash;if lid is null then return null;end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-link:'||lid::text,0));
 select coalesce(jsonb_agg(jsonb_build_object('offerId',o.id,'workspaceId',o.workspace_id,'projectId',o.project_id,'propertyId',o.property_id,'unitId',o.unit_id,'meetingPageId',m.id,'linkId',l.id,'title',v.snapshot->>'title','unitNumber',u.unit_number,'path','/book/'||w.public_key||'/'||m.slug,'timeZone',coalesce(m.calendar_integrations#>>'{availability,timeZone}','Europe/Vienna'),'page',jsonb_build_object('id',m.id,'workspaceId',m.workspace_id,'projectId',m.project_id,'ownerUserId',m.owner_user_id,'slug',m.slug,'title',m.title,'calendarIntegrations',m.calendar_integrations,'automation',m.automation,'shareConfig',m.share_config,'workspacePublicKey',w.public_key)) order by u.unit_number),'[]'::jsonb) into result
 from web_expose_links l join web_expose_versions v on v.workspace_id=l.workspace_id and v.id=l.version_id
 join property_booking_offers o on o.workspace_id=v.workspace_id and o.property_id=v.property_id and o.project_id=v.project_id and o.enabled
 join seller_listings p on p.workspace_id=o.workspace_id and p.id=o.property_id and p.project_id=o.project_id
 join property_units u on u.workspace_id=o.workspace_id and u.id=o.unit_id and u.project_id=o.project_id
 join meeting_pages m on m.workspace_id=o.workspace_id and m.id=o.meeting_page_id and m.project_id=o.project_id and m.status='active'
 join workspace_users actor on actor.workspace_id=o.workspace_id and actor.id=o.configured_by and actor.status='active'
 join workspaces w on w.id=o.workspace_id
 where l.id=lid and l.revoked_at is null and (l.expires_at is null or l.expires_at>clock_timestamp()) and v.active and (p_offer is null or o.id=p_offer)
 and u.status='available' and coalesce(u.metadata->>'hidden','false')<>'true' and (u.metadata->>'sellerListingId'=p.id::text or p.unit_id=u.id)
 and coalesce(p.canonical_payload#>>'{onboardingExample,synthetic}','false')<>'true'
 and p.property_status not in('archived','error','paused') and p.data_classification not in('PRIVATE_FRANZ','UNCLASSIFIED')
 and exists(select 1 from workspace_users publisher where publisher.workspace_id=v.workspace_id and publisher.id=v.created_by and publisher.status='active')
 and actor.role in('owner','admin','agent') and actor.product_role not in('external_partner','viewer') and (actor.role in('owner','admin') or exists(select 1 from project_pipeline_permissions g where g.workspace_id=o.workspace_id and g.project_id=o.project_id and g.user_id=actor.id and g.can_read and g.can_edit_deals))
 and exists(select 1 from jsonb_array_elements(v.snapshot->'units') item where item->>'id'=u.id::text and item->>'status'='available');
 return result;
end $$;
create function crm_property_booking_source() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare context jsonb;binding property_meeting_bookings;begin
 if tg_op='INSERT' then
  if not(new.metadata?'propertyBookingOfferId' or new.metadata?'propertyExposeTokenHash') then return new;end if;
  if coalesce(new.metadata->>'propertyExposeTokenHash','')!~'^[a-f0-9]{64}$' or coalesce(new.metadata->>'propertyBookingOfferId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then raise exception using errcode='23514',message='Complete server-bound property context required';end if;
  context:=crm_property_booking_context(new.metadata->>'propertyExposeTokenHash',(new.metadata->>'propertyBookingOfferId')::uuid)->0;
  if context is null or context->>'workspaceId' is distinct from new.workspace_id::text or context->>'meetingPageId' is distinct from new.meeting_page_id::text or new.contact_id is not null or new.status<>'requested' or new.starts_at<=clock_timestamp() or new.ends_at<=new.starts_at then raise exception using errcode='23514',message='Public property booking context unavailable';end if;
  perform pg_advisory_xact_lock(hashtextextended('property-booking-unit:'||(context->>'unitId'),0));
  if exists(select 1 from property_meeting_bookings a join meeting_bookings b on b.id=a.booking_id and b.workspace_id=a.workspace_id where a.workspace_id=new.workspace_id and a.unit_id=(context->>'unitId')::uuid and b.status<>'cancelled' and b.starts_at<new.ends_at and b.ends_at>new.starts_at) then raise exception using errcode='23505',message='Property viewing slot already requested';end if;
  insert into property_meeting_bookings(booking_id,workspace_id,project_id,property_id,unit_id,offer_id,expose_link_id)
  values(new.id,new.workspace_id,(context->>'projectId')::uuid,(context->>'propertyId')::uuid,(context->>'unitId')::uuid,(context->>'offerId')::uuid,(context->>'linkId')::uuid);
 else
  select * into binding from property_meeting_bookings where booking_id=new.id and workspace_id=new.workspace_id for update;if not found then return new;end if;
  if (new.workspace_id,new.meeting_page_id) is distinct from (old.workspace_id,old.meeting_page_id) or new.metadata->>'propertyBookingOfferId' is distinct from old.metadata->>'propertyBookingOfferId' or new.metadata->>'propertyExposeTokenHash' is distinct from old.metadata->>'propertyExposeTokenHash' then raise exception using errcode='23514',message='Property booking origin immutable';end if;
  if (new.contact_name,new.contact_email) is distinct from (old.contact_name,old.contact_email) then raise exception using errcode='23514',message='Submitted participant is immutable';end if;
  if new.status='confirmed' and binding.status<>'confirmed' then raise exception using errcode='23514',message='Staff must confirm the property participant and viewing first';end if;
  if new.status='cancelled' and old.status<>'cancelled' then
   update property_meeting_bookings set status='cancelled',version=version+1,updated_at=clock_timestamp() where booking_id=new.id;
   update property_viewing_slots set status='cancelled',version=version+1,updated_at=clock_timestamp() where workspace_id=binding.workspace_id and id=binding.viewing_id and status in('planned','confirmed');
   update calendar_events c set status='abgesagt',metadata=c.metadata||jsonb_build_object('propertyViewingReview','cancelled'),updated_at=clock_timestamp() from property_viewing_slots v where v.workspace_id=binding.workspace_id and v.id=binding.viewing_id and c.workspace_id=v.workspace_id and c.id=v.calendar_event_id and c.metadata->>'bookingId'=new.id::text;
  elsif (new.starts_at,new.ends_at) is distinct from (old.starts_at,old.ends_at) then
   if binding.status='cancelled' then raise exception using errcode='23514',message='Cancelled property bookings cannot be rescheduled';end if;
   perform pg_advisory_xact_lock(hashtextextended('property-booking-unit:'||binding.unit_id::text,0));
   if exists(select 1 from property_meeting_bookings a join meeting_bookings b on b.id=a.booking_id and b.workspace_id=a.workspace_id where a.workspace_id=new.workspace_id and a.unit_id=binding.unit_id and b.id<>new.id and b.status<>'cancelled' and b.starts_at<new.ends_at and b.ends_at>new.starts_at) then raise exception using errcode='23505',message='Property viewing slot already requested';end if;
   update property_meeting_bookings set status='needs_review',version=version+1,updated_at=clock_timestamp() where booking_id=new.id;
   update property_viewing_slots set status='planned',starts_at=new.starts_at,ends_at=new.ends_at,version=version+1,updated_at=clock_timestamp() where workspace_id=binding.workspace_id and id=binding.viewing_id and status in('planned','confirmed');
   update calendar_events c set status='geplant',starts_at=new.starts_at,ends_at=new.ends_at,metadata=c.metadata||jsonb_build_object('propertyViewingReview','required'),updated_at=clock_timestamp() from property_viewing_slots v where v.workspace_id=binding.workspace_id and v.id=binding.viewing_id and c.workspace_id=v.workspace_id and c.id=v.calendar_event_id and c.metadata->>'bookingId'=new.id::text;
  end if;
 end if;return new;
end $$;
create trigger property_booking_source after insert or update on meeting_bookings for each row execute function crm_property_booking_source();
revoke all on property_booking_offers,property_meeting_bookings from public,novalure_app;
revoke all on function crm_property_booking_staff_guard(),crm_property_booking_source(),crm_property_booking_context(text,uuid) from public;
grant execute on function crm_property_booking_context(text,uuid) to novalure_app,novalure_tenant_app;

-- Capability readers/writers deliberately add no anonymous table grants.
create function crm_property_booking_busy(p_hash text,p_offer uuid,p_min timestamptz,p_max timestamptz) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c jsonb;result jsonb;begin
 c:=crm_property_booking_context(p_hash,p_offer)->0;if c is null or p_max<=p_min or p_max-p_min>interval '2 days' then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('startsAt',b.starts_at,'endsAt',b.ends_at)),'[]'::jsonb) into result from meeting_bookings b where b.workspace_id=(c->>'workspaceId')::uuid and b.status<>'cancelled' and b.starts_at<p_max and b.ends_at>p_min and (b.meeting_page_id=(c->>'meetingPageId')::uuid or exists(select 1 from property_meeting_bookings a where a.booking_id=b.id and a.workspace_id=b.workspace_id and a.unit_id=(c->>'unitId')::uuid));return result;
end $$;
create function crm_property_booking_create(p_hash text,p_offer uuid,p_name text,p_email text,p_note text,p_start timestamptz,p_end timestamptz,p_public_token uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c jsonb;page jsonb;bid uuid;begin
 c:=crm_property_booking_context(p_hash,p_offer)->0;if c is null or p_offer is null or p_public_token is null or length(trim(coalesce(p_name,''))) not between 1 and 160 or length(coalesce(p_email,''))>320 or p_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(coalesce(p_note,''))>2000 or p_start<=clock_timestamp() or p_end<=p_start or p_end-p_start>interval '8 hours' then raise exception using errcode='23514',message='Property booking request unavailable';end if;
 page:=c->'page';perform crm_property_booking_assert_slot(page,p_start,p_end);
 perform pg_advisory_xact_lock(hashtextextended('property-booking-page:'||(c->>'meetingPageId'),0));
 if exists(select 1 from meeting_bookings b where b.workspace_id=(c->>'workspaceId')::uuid and b.meeting_page_id=(c->>'meetingPageId')::uuid and b.status<>'cancelled' and b.starts_at<p_end and b.ends_at>p_start) then raise exception using errcode='23505',message='Meeting slot already requested';end if;
 insert into meeting_bookings(workspace_id,meeting_page_id,slug,title,contact_name,contact_email,contact_note,starts_at,ends_at,calendar_provider,meeting_provider,source,metadata)
 values((c->>'workspaceId')::uuid,(c->>'meetingPageId')::uuid,page->>'slug',page->>'title',trim(p_name),lower(trim(p_email)),coalesce(p_note,''),p_start,p_end,coalesce(page#>>'{calendarIntegrations,defaultProvider}','none'),coalesce(page#>>'{calendarIntegrations,defaultMeetingProvider}','manual-link'),'web_expose',jsonb_build_object('publicToken',p_public_token,'propertyBookingOfferId',p_offer,'propertyExposeTokenHash',p_hash,'allowCancel',coalesce((page#>>'{automation,allowCancel}')::boolean,true),'allowReschedule',coalesce((page#>>'{automation,allowReschedule}')::boolean,true))) returning id into bid;return jsonb_build_object('id',bid);
end $$;
create function crm_property_booking_action_lookup(p_booking uuid,p_token text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',b.id,'workspaceId',b.workspace_id,'meetingPageId',b.meeting_page_id,'slug',b.slug,'title',b.title,'contactName',b.contact_name,'contactEmail',b.contact_email,'contactNote',b.contact_note,'startsAt',b.starts_at,'endsAt',b.ends_at,'calendarProvider',case when nullif(b.metadata->>'externalCalendarId','') is not null then b.calendar_provider when sync.provider='google-workspace' then 'google' when sync.provider='microsoft-365' then 'microsoft' else b.calendar_provider end,'meetingProvider',b.meeting_provider,'status',b.status,'metadata',b.metadata||case when nullif(b.metadata->>'externalCalendarId','') is null and sync.provider_event_id is not null then jsonb_build_object('externalCalendarId',sync.provider_event_id,'calendarEventId',c.id) else '{}'::jsonb end,'pageSlug',m.slug,'pageTitle',m.title,'automation',m.automation,'calendarIntegrations',m.calendar_integrations,'workspacePublicKey',w.public_key)
 from meeting_bookings b join property_meeting_bookings a on a.booking_id=b.id and a.workspace_id=b.workspace_id join meeting_pages m on m.id=b.meeting_page_id and m.workspace_id=b.workspace_id join workspaces w on w.id=b.workspace_id
 left join property_viewing_slots v on v.workspace_id=a.workspace_id and v.id=a.viewing_id left join calendar_events c on c.workspace_id=v.workspace_id and c.id=v.calendar_event_id
 left join lateral(select s.provider,s.provider_event_id from calendar_sync_events s where s.workspace_id=b.workspace_id and s.calendar_event_id=c.id and s.status='synced' and s.provider in('microsoft-365','google-workspace') and nullif(s.provider_event_id,'') is not null order by s.created_at desc,s.id desc limit 1) sync on true
 where b.id=p_booking and length(coalesce(p_token,''))=36 and b.metadata->>'publicToken'=p_token
$$;
create function crm_property_booking_action_update(p_booking uuid,p_token text,p_action text,p_start timestamptz,p_end timestamptz,p_metadata jsonb) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare b meeting_bookings;a jsonb;page jsonb;hours numeric;begin
 select mb.* into b from meeting_bookings mb join property_meeting_bookings binding on binding.booking_id=mb.id and binding.workspace_id=mb.workspace_id where mb.id=p_booking and mb.metadata->>'publicToken'=p_token for update of mb;if not found then return false;end if;
 select automation,jsonb_build_object('calendarIntegrations',calendar_integrations) into a,page from meeting_pages where workspace_id=b.workspace_id and id=b.meeting_page_id;
 if p_action not in('cancel','reschedule') or (a->>('allow'||case when p_action='cancel' then 'Cancel' else 'Reschedule' end))='false' then return false;end if;
 hours:=case when coalesce(a->>(p_action||'DeadlineHours'),'')~'^[0-9]+(\.[0-9]+)?$' then (a->>(p_action||'DeadlineHours'))::numeric else case when p_action='cancel' then 24 else 12 end end;
 if b.status='cancelled' then return p_action='cancel';end if;if clock_timestamp()>b.starts_at-hours*interval '1 hour' then return false;end if;
 if jsonb_typeof(p_metadata) is distinct from 'object' or octet_length(p_metadata::text)>10000 or exists(select 1 from jsonb_object_keys(p_metadata) k where k not in('cancelReason','cancelledAt','externalCalendarAction','previousStartsAt','rescheduledAt')) then return false;end if;
 if p_action='cancel' then update meeting_bookings set status='cancelled',metadata=metadata||p_metadata,updated_at=clock_timestamp() where id=b.id;
 else if p_start<=clock_timestamp() or p_end<=p_start or p_end-p_start>interval '8 hours' then return false;end if;perform crm_property_booking_assert_slot(page,p_start,p_end);perform pg_advisory_xact_lock(hashtextextended('property-booking-page:'||b.meeting_page_id::text,0));if exists(select 1 from meeting_bookings other where other.workspace_id=b.workspace_id and other.meeting_page_id=b.meeting_page_id and other.id<>b.id and other.status<>'cancelled' and other.starts_at<p_end and other.ends_at>p_start) then raise exception using errcode='23505',message='Meeting slot already requested';end if;update meeting_bookings set status='rescheduled',starts_at=p_start,ends_at=p_end,metadata=metadata||p_metadata,updated_at=clock_timestamp() where id=b.id;end if;
 update meeting_notification_jobs set status='cancelled',updated_at=clock_timestamp() where booking_id=b.id and status in('queued','retry','sending');return true;
end $$;
create function crm_property_booking_staff_state(p_workspace uuid,p_property uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare pid uuid;result jsonb;begin
 if not crm_web_expose_access(p_workspace,p_property,false) then raise exception using errcode='42501',message='Property booking read denied';end if;
 select project_id into pid from seller_listings where workspace_id=p_workspace and id=p_property;
 select jsonb_build_object('pages',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'title',m.title) order by m.title),'[]'::jsonb) from meeting_pages m where m.workspace_id=p_workspace and m.project_id=pid and m.status='active'),
 'offers',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'unitId',o.unit_id,'unitNumber',u.unit_number,'meetingPageId',m.id,'meetingTitle',m.title,'enabled',o.enabled,'version',o.version) order by u.unit_number),'[]'::jsonb) from property_booking_offers o join property_units u on u.workspace_id=o.workspace_id and u.id=o.unit_id join meeting_pages m on m.workspace_id=o.workspace_id and m.id=o.meeting_page_id where o.workspace_id=p_workspace and o.property_id=p_property),
 'requests',(select coalesce(jsonb_agg(x.dto order by x.starts_at desc),'[]'::jsonb) from (select b.starts_at,jsonb_build_object('bookingId',b.id,'unitNumber',u.unit_number,'contactName',b.contact_name,'contactEmail',b.contact_email,'contactNote',b.contact_note,'startsAt',b.starts_at,'endsAt',b.ends_at,'bookingStatus',b.status,'status',a.status,'leadId',a.lead_id,'viewingId',a.viewing_id,'reason',a.review_reason,'version',a.version) dto from property_meeting_bookings a join meeting_bookings b on b.workspace_id=a.workspace_id and b.id=a.booking_id join property_units u on u.workspace_id=a.workspace_id and u.id=a.unit_id where a.workspace_id=p_workspace and a.property_id=p_property order by b.starts_at desc limit 100) x)) into result;return result;
end $$;
create function crm_property_booking_action_busy(p_booking uuid,p_token text,p_min timestamptz,p_max timestamptz) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare scope property_meeting_bookings;page uuid;result jsonb;begin
 if crm_property_booking_action_lookup(p_booking,p_token) is null or p_max<=p_min or p_max-p_min>interval '2 days' then return '[]'::jsonb;end if;
 select * into scope from property_meeting_bookings where booking_id=p_booking;select meeting_page_id into page from meeting_bookings where id=p_booking;
 select coalesce(jsonb_agg(jsonb_build_object('startsAt',b.starts_at,'endsAt',b.ends_at)),'[]'::jsonb) into result from meeting_bookings b where b.workspace_id=scope.workspace_id and b.id<>p_booking and b.status<>'cancelled' and b.starts_at<p_max and b.ends_at>p_min and (b.meeting_page_id=page or exists(select 1 from property_meeting_bookings a where a.booking_id=b.id and a.workspace_id=b.workspace_id and a.unit_id=scope.unit_id));return result;
end $$;
create function crm_property_booking_staff_lock(p_workspace uuid,p_property uuid,p_booking uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;begin
 if not crm_web_expose_access(p_workspace,p_property,true) then raise exception using errcode='42501',message='Property booking command denied';end if;
 select jsonb_build_object('id',b.id,'starts_at',b.starts_at,'ends_at',b.ends_at,'status',b.status,'time_zone',coalesce(m.calendar_integrations#>>'{availability,timeZone}','Europe/Vienna')) into result from meeting_bookings b join meeting_pages m on m.workspace_id=b.workspace_id and m.id=b.meeting_page_id where b.workspace_id=p_workspace and b.id=p_booking and exists(select 1 from property_meeting_bookings a where a.workspace_id=p_workspace and a.booking_id=b.id and a.property_id=p_property) for update of b;return result;
end $$;
create function crm_property_booking_staff_mark_confirmed(p_workspace uuid,p_property uuid,p_booking uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not crm_web_expose_access(p_workspace,p_property,true) or not exists(select 1 from property_meeting_bookings a join property_viewing_slots v on v.workspace_id=a.workspace_id and v.id=a.viewing_id join meeting_bookings b on b.workspace_id=a.workspace_id and b.id=a.booking_id where a.workspace_id=p_workspace and a.property_id=p_property and a.booking_id=p_booking and a.status='confirmed' and a.reviewed_by=nullif(current_setting('app.actor_id',true),'')::uuid and v.status='confirmed' and v.starts_at=b.starts_at and v.ends_at=b.ends_at) then raise exception using errcode='42501',message='Current staff-confirmed viewing required';end if;
 update meeting_bookings b set status='confirmed',metadata=b.metadata||jsonb_build_object('calendarEventId',v.calendar_event_id),updated_at=clock_timestamp() from property_meeting_bookings a join property_viewing_slots v on v.workspace_id=a.workspace_id and v.id=a.viewing_id where b.workspace_id=p_workspace and b.id=p_booking and a.workspace_id=b.workspace_id and a.booking_id=b.id;return true;
end $$;
create function crm_property_booking_staff_confirmation(p_workspace uuid,p_booking uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;begin
 select crm_property_booking_action_lookup(b.id,b.metadata->>'publicToken')||jsonb_build_object('contactId',l.contact_id,'projectId',a.project_id,'ownerUserId',m.owner_user_id) into result from property_meeting_bookings a join meeting_bookings b on b.workspace_id=a.workspace_id and b.id=a.booking_id join meeting_pages m on m.workspace_id=b.workspace_id and m.id=b.meeting_page_id left join leads l on l.workspace_id=a.workspace_id and l.id=a.lead_id where a.workspace_id=p_workspace and a.booking_id=p_booking and crm_web_expose_access(a.workspace_id,a.property_id,true);return result;
end $$;
revoke all on function crm_property_booking_busy(text,uuid,timestamptz,timestamptz),crm_property_booking_create(text,uuid,text,text,text,timestamptz,timestamptz,uuid),crm_property_booking_action_lookup(uuid,text),crm_property_booking_action_update(uuid,text,text,timestamptz,timestamptz,jsonb),crm_property_booking_staff_state(uuid,uuid),crm_property_booking_staff_lock(uuid,uuid,uuid),crm_property_booking_staff_mark_confirmed(uuid,uuid,uuid) from public;
grant execute on function crm_property_booking_busy(text,uuid,timestamptz,timestamptz),crm_property_booking_create(text,uuid,text,text,text,timestamptz,timestamptz,uuid),crm_property_booking_action_lookup(uuid,text),crm_property_booking_action_update(uuid,text,text,timestamptz,timestamptz,jsonb) to novalure_app,novalure_tenant_app;
revoke all on function crm_property_booking_staff_confirmation(uuid,uuid) from public;
revoke all on function crm_property_booking_action_busy(uuid,text,timestamptz,timestamptz) from public;
grant execute on function crm_property_booking_action_busy(uuid,text,timestamptz,timestamptz) to novalure_app,novalure_tenant_app;
grant execute on function crm_property_booking_staff_state(uuid,uuid),crm_property_booking_staff_lock(uuid,uuid,uuid),crm_property_booking_staff_mark_confirmed(uuid,uuid,uuid),crm_property_booking_staff_confirmation(uuid,uuid) to novalure_tenant_app;

create function crm_property_booking_assert_slot(p_page jsonb,p_start timestamptz,p_end timestamptz) returns void language plpgsql set search_path=pg_catalog,public as $$
declare config jsonb:=coalesce(p_page#>'{calendarIntegrations,availability}','{}');zone text:=coalesce(p_page#>>'{calendarIntegrations,availability,timeZone}','Europe/Vienna');duration numeric:=30;spacing numeric:=30;notice numeric:=15;weeks numeric:=2;local_start timestamp;local_end timestamp;windows jsonb;allowed boolean;begin
 if not exists(select 1 from pg_timezone_names where name=zone) then raise exception using errcode='23514',message='Valid meeting timezone required';end if;
 if coalesce(config->>'durationMinutes','')~'^[0-9]+(\.[0-9]+)?$' then duration:=least(480,greatest(5,(config->>'durationMinutes')::numeric));end if;
 if coalesce(config->>'intervalMinutes','')~'^[0-9]+(\.[0-9]+)?$' then spacing:=least(240,greatest(5,(config->>'intervalMinutes')::numeric));end if;
 if coalesce(config->>'minNoticeMinutes','')~'^[0-9]+(\.[0-9]+)?$' then notice:=least(10080,greatest(0,(config->>'minNoticeMinutes')::numeric));end if;
 if coalesce(config->>'rollingWeeks','')~'^[0-9]+(\.[0-9]+)?$' then weeks:=least(52,greatest(1,(config->>'rollingWeeks')::numeric));end if;
 local_start:=p_start at time zone zone;local_end:=p_end at time zone zone;
 if p_start is null or p_end is null or p_end-p_start<>duration*interval '1 minute' or p_start<clock_timestamp()+notice*interval '1 minute' or local_start::date<(clock_timestamp() at time zone zone)::date or local_start::date>=(clock_timestamp() at time zone zone)::date+(ceil(weeks*7)::int) or local_start::date<>local_end::date then raise exception using errcode='23514',message='Meeting slot outside configured duration or booking window';end if;
 windows:=case when jsonb_typeof(config->'weeklyHours')='array' then config->'weeklyHours' else '[{"day":1,"start":"09:00","end":"17:00"},{"day":2,"start":"09:00","end":"17:00"},{"day":3,"start":"09:00","end":"17:00"},{"day":4,"start":"09:00","end":"17:00"},{"day":5,"start":"09:00","end":"17:00"}]'::jsonb end;
 select exists(select 1 from jsonb_array_elements(windows) win where win->>'day'=extract(dow from local_start)::int::text and coalesce(win->>'start','')~'^([01][0-9]|2[0-3]):[0-5][0-9]$' and coalesce(win->>'end','')~'^([01][0-9]|2[0-3]):[0-5][0-9]$' and local_start::time>=(win->>'start')::time and local_end::time<=(win->>'end')::time and mod(extract(epoch from(local_start::time-(win->>'start')::time))/60,spacing)=0) into allowed;
 if not allowed then raise exception using errcode='23514',message='Meeting slot outside configured weekly hours';end if;
end $$;
revoke all on function crm_property_booking_assert_slot(jsonb,timestamptz,timestamptz) from public;

create function crm_property_booking_notification_current(p_job uuid,p_lease text) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from meeting_notification_jobs j join meeting_bookings b on b.id=j.booking_id and b.workspace_id=j.workspace_id where j.id=p_job and j.status='sending' and j.locked_by=p_lease and j.lease_expires_at>clock_timestamp() and b.status<>'cancelled' and not exists(select 1 from property_meeting_bookings a left join property_viewing_slots v on v.workspace_id=a.workspace_id and v.id=a.viewing_id where a.workspace_id=b.workspace_id and a.booking_id=b.id and (a.status<>'confirmed' or v.status is distinct from 'confirmed')))
$$;
revoke all on function crm_property_booking_notification_current(uuid,text) from public;
grant execute on function crm_property_booking_notification_current(uuid,text) to novalure_app,novalure_tenant_app;
