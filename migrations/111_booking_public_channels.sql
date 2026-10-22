-- Additive published booking authority. No publication, channel or production binding is enabled here.
set local lock_timeout = '5s';
set local statement_timeout = '14min';
create table public.booking_publications (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null unique references public.workspaces(id),
 owner_id uuid not null,public_id text not null unique check(public_id~'^[a-z0-9][a-z0-9-]{10,79}$'),
 enabled boolean not null default false,config jsonb not null check(jsonb_typeof(config)='object'),revision bigint not null default 1,
 published_at timestamptz,legacy_meeting_page_ids uuid[] not null default '{}',
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),foreign key(workspace_id,owner_id) references public.workspace_users(workspace_id,id)
);
create table public.booking_publication_assignments (
 id uuid primary key,workspace_id uuid not null,publication_id uuid not null,organizer_id uuid not null,
 kind text not null check(kind in ('phone','teams','meet','office','onsite')),provider text not null check(provider in ('microsoft','google')),
 enabled boolean not null default true,
 unique(workspace_id,organizer_id,id),unique(workspace_id,publication_id,id),
 foreign key(workspace_id,publication_id) references public.booking_publications(workspace_id,id),
 foreign key(workspace_id,organizer_id) references public.workspace_users(workspace_id,id)
);
-- Sticky resource cutover: later legacy pages owned by this exact organizer
-- cannot create a second engine. Runtime cannot remove or rewrite this record.
create table public.booking_publication_organizer_cutovers (
 workspace_id uuid not null,organizer_id uuid not null,publication_id uuid not null,
 first_published_at timestamptz not null default now(),primary key(workspace_id,organizer_id),
 foreign key(workspace_id,publication_id) references public.booking_publications(workspace_id,id),
 foreign key(workspace_id,organizer_id) references public.workspace_users(workspace_id,id)
);
create table public.booking_channel_sessions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,organizer_id uuid not null,publication_id uuid not null,assignment_id uuid not null,
 publication_revision bigint not null,token_hash text not null unique check(token_hash~'^[a-f0-9]{64}$'),ip_hash text not null check(ip_hash~'^[a-f0-9]{64}$'),
 origin text not null,channel text not null check(channel in ('link','inline','popup','form','chat','voice')),
 language text not null check(language in ('de','en')),binding_id text,relation jsonb not null default '{}' check(jsonb_typeof(relation)='object'),
 expires_at timestamptz not null,request_count integer not null default 0,hold_count integer not null default 0,revoked_at timestamptz,
 created_at timestamptz not null default now(),unique(workspace_id,organizer_id,id),
 foreign key(workspace_id,publication_id) references public.booking_publications(workspace_id,id),
 foreign key(workspace_id,organizer_id,assignment_id) references public.booking_publication_assignments(workspace_id,organizer_id,id)
);
create table public.booking_channel_operations (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,organizer_id uuid not null,session_id uuid not null,
 action text not null check(action in ('hold','confirm','reschedule','cancel')),client_key uuid not null,core_key uuid not null,
 request_hash text not null,booking_id uuid,state text not null check(state in ('attempting','succeeded','unknown','rejected')),error_code text,
 consent_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(session_id,action,client_key),
 foreign key(workspace_id,organizer_id,session_id) references public.booking_channel_sessions(workspace_id,organizer_id,id),
 foreign key(workspace_id,organizer_id,booking_id) references public.booking_reservations(workspace_id,organizer_id,id)
);
create index booking_channel_own_bookings on public.booking_channel_operations(session_id,booking_id);
create table public.booking_channel_rate_buckets (
 publication_id uuid not null references public.booking_publications(id),ip_hash text not null,
 kind text not null check(kind in ('session','hold')),window_started_at timestamptz not null,attempts integer not null,
 primary key(publication_id,ip_hash,kind)
);
do $$ declare t text; begin
 foreach t in array array['booking_publications','booking_publication_assignments','booking_publication_organizer_cutovers','booking_channel_sessions','booking_channel_operations','booking_channel_rate_buckets'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,novalure_app,novalure_tenant_app',t);
 end loop;
end $$;
create policy booking_publication_manager on public.booking_publications for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid) and public.crm_workspace_manager(workspace_id))
 with check(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid) and public.crm_workspace_manager(workspace_id));
create policy booking_assignment_manager on public.booking_publication_assignments for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid) and public.crm_workspace_manager(workspace_id))
 with check(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid) and public.crm_workspace_manager(workspace_id));
create policy booking_organizer_cutover_manager on public.booking_publication_organizer_cutovers for select to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid) and public.crm_workspace_manager(workspace_id));
create policy booking_organizer_cutover_publish on public.booking_publication_organizer_cutovers for insert to novalure_tenant_app
 with check(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid) and public.crm_workspace_manager(workspace_id)
 and exists(select 1 from public.booking_publications p where p.id=booking_publication_organizer_cutovers.publication_id and p.workspace_id=booking_publication_organizer_cutovers.workspace_id and p.published_at is not null and p.enabled)
 and exists(select 1 from public.booking_publication_assignments a where a.publication_id=booking_publication_organizer_cutovers.publication_id and a.workspace_id=booking_publication_organizer_cutovers.workspace_id and a.organizer_id=booking_publication_organizer_cutovers.organizer_id and a.enabled));
grant select,insert on public.booking_publication_organizer_cutovers to novalure_tenant_app;
create policy booking_channel_session_actor on public.booking_channel_sessions for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,organizer_id)) with check(public.booking_actor_allowed(workspace_id,organizer_id));
create policy booking_channel_operation_actor on public.booking_channel_operations for all to novalure_tenant_app
 using(public.booking_actor_allowed(workspace_id,organizer_id)) with check(public.booking_actor_allowed(workspace_id,organizer_id));
grant select,insert,update on public.booking_publications,public.booking_publication_assignments,public.booking_channel_sessions,public.booking_channel_operations to novalure_tenant_app;

-- Exact public identifier lookup only. No credential, calendar contents or arbitrary SQL is returned.
create function public.booking_publication_lookup(p_public_id text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',id,'workspaceId',workspace_id,'ownerId',owner_id,'config',config,'revision',revision)
 from public.booking_publications where public_id=p_public_id and enabled and length(p_public_id) between 11 and 80
$$;
create function public.booking_workspace_publication_lookup(p_workspace uuid,p_meeting_page uuid default null) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('publicId',p.public_id,'config',case
  when p_meeting_page is null or coalesce(p.config->'legacyMeetingPageIds','[]'::jsonb)?p_meeting_page::text
   or exists(select 1 from public.booking_publication_assignments a where a.workspace_id=p.workspace_id and a.publication_id=p.id and a.organizer_id=page.owner_user_id and a.enabled)
  then p.config else jsonb_set(p.config,'{enabled}','false'::jsonb) end)
 from public.booking_publications p
 left join public.meeting_pages page on page.id=p_meeting_page and page.workspace_id=p.workspace_id
 left join public.booking_publication_organizer_cutovers cutover on cutover.workspace_id=p.workspace_id and cutover.organizer_id=page.owner_user_id and cutover.publication_id=p.id
 where p.workspace_id=p_workspace and p.published_at is not null
 and (p_meeting_page is null or p_meeting_page=any(p.legacy_meeting_page_ids) or cutover.organizer_id is not null)
$$;
-- Existing meeting pages intentionally have no raw runtime SELECT privilege.
do $legacy_owner_read$ begin
 execute format($policy$create policy booking_publication_owner_legacy_read on public.meeting_pages for select to %I
  using(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid) and public.crm_workspace_manager(workspace_id))$policy$,current_user);
end $legacy_owner_read$;
create function public.booking_publication_legacy_pages_allowed(p_workspace uuid,p_pages uuid[]) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select public.booking_actor_allowed(p_workspace,nullif(current_setting('app.actor_id',true),'')::uuid)
 and public.crm_workspace_manager(p_workspace) and cardinality(p_pages)<=30
 and (select count(distinct id) from public.meeting_pages where workspace_id=p_workspace and id=any(p_pages))=cardinality(p_pages)
$$;
revoke all on function public.booking_publication_legacy_pages_allowed(uuid,uuid[]) from public;
grant execute on function public.booking_publication_legacy_pages_allowed(uuid,uuid[]) to novalure_tenant_app;
create function public.booking_channel_session_lookup(p_token_hash text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',s.id,'workspaceId',s.workspace_id,'organizerId',s.organizer_id,'publicationId',s.publication_id,'assignmentId',s.assignment_id,
 'channel',s.channel,'language',s.language,'bindingId',s.binding_id,'relation',s.relation,'origin',s.origin,'ipHash',s.ip_hash,'expiresAt',s.expires_at,
 'provider',a.provider,'kind',a.kind,'publication',jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'ownerId',p.owner_id,'config',p.config,'revision',p.revision))
 from public.booking_channel_sessions s join public.booking_publications p on p.id=s.publication_id and p.workspace_id=s.workspace_id
 join public.booking_publication_assignments a on a.id=s.assignment_id and a.workspace_id=s.workspace_id and a.organizer_id=s.organizer_id
 where s.token_hash=p_token_hash and p.enabled and a.enabled and p.revision=s.publication_revision
 and coalesce((p.config->'channels'->>s.channel)::boolean,false) and s.revoked_at is null and s.expires_at>now()
 and p_token_hash~'^[a-f0-9]{64}$'
$$;
-- Durable, cross-worker budgets; current actor must be a published organizer in this workspace.
create function public.booking_channel_reserve_budget(p_publication uuid,p_ip_hash text,p_kind text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer; max_attempts integer;
begin
 if p_kind not in ('session','hold') or p_ip_hash!~'^[a-f0-9]{64}$' or not exists(
  select 1 from public.booking_publication_assignments a join public.booking_publications p on p.id=a.publication_id
  where p.id=p_publication and p.enabled and a.enabled and public.booking_actor_allowed(a.workspace_id,a.organizer_id)) then return false; end if;
 max_attempts:=case p_kind when 'session' then 12 else 20 end;
 insert into public.booking_channel_rate_buckets(publication_id,ip_hash,kind,window_started_at,attempts)
 values(p_publication,p_ip_hash,p_kind,now(),1) on conflict(publication_id,ip_hash,kind) do update
 set attempts=case when booking_channel_rate_buckets.window_started_at<now()-interval '1 hour' then 1 else booking_channel_rate_buckets.attempts+1 end,
 window_started_at=case when booking_channel_rate_buckets.window_started_at<now()-interval '1 hour' then now() else booking_channel_rate_buckets.window_started_at end
 returning attempts into n;
 delete from public.booking_channel_rate_buckets where publication_id=p_publication and window_started_at<now()-interval '1 day';
 return n<=max_attempts;
end $$;
-- Preserve the authoritative CRM record and attach only server-verified, same-workspace relation IDs.
create function public.booking_channel_attach_crm_relation(p_session uuid,p_booking uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s record;b record;related_lead uuid;related_contact uuid;
begin
 select * into s from public.booking_channel_sessions where id=p_session;
 if not found or not public.booking_actor_allowed(s.workspace_id,s.organizer_id) then raise exception using errcode='42501',message='Channel denied'; end if;
 if not exists(select 1 from public.booking_channel_operations o where o.session_id=s.id and o.booking_id=p_booking and o.action='hold' and o.state='succeeded') then raise exception using errcode='42501',message='Channel denied'; end if;
 select * into b from public.booking_reservations where id=p_booking and workspace_id=s.workspace_id and organizer_id=s.organizer_id;
 if not found or b.crm_booking_id is null then return; end if;
 if coalesce(s.relation->>'leadId','')<>'' then
  related_lead:=(s.relation->>'leadId')::uuid;
  if not exists(select 1 from public.leads where id=related_lead and workspace_id=s.workspace_id) then raise exception using errcode='42501',message='Channel relation denied'; end if;
 end if;
 if coalesce(s.relation->>'contactId','')<>'' then
  related_contact:=(s.relation->>'contactId')::uuid;
  if not exists(select 1 from public.contacts where id=related_contact and workspace_id=s.workspace_id) then raise exception using errcode='42501',message='Channel relation denied'; end if;
 end if;
 update public.meeting_bookings set contact_id=coalesce(related_contact,contact_id),contact_name=coalesce(nullif(b.recipient_name,''),contact_name),contact_email=coalesce(b.recipient_email,contact_email),
 metadata=metadata||jsonb_build_object('bookingPublicationId',s.publication_id,'bookingChannel',s.channel,'bookingChannelSessionId',s.id,'bookingChannelRelation',s.relation),updated_at=now()
 where id=b.crm_booking_id and workspace_id=s.workspace_id and metadata->>'universalBookingId'=b.id::text;
end $$;
revoke all on function public.booking_publication_lookup(text),public.booking_workspace_publication_lookup(uuid,uuid),public.booking_channel_session_lookup(text),public.booking_channel_reserve_budget(uuid,text,text),public.booking_channel_attach_crm_relation(uuid,uuid) from public;
grant execute on function public.booking_publication_lookup(text),public.booking_workspace_publication_lookup(uuid,uuid),public.booking_channel_session_lookup(text),public.booking_channel_reserve_budget(uuid,text,text),public.booking_channel_attach_crm_relation(uuid,uuid) to novalure_tenant_app;
-- Preflight exposes a boolean only; each actual action still verifies its own exact publication/session origin.
create function public.booking_channel_origin_allowed(p_origin text) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select length(p_origin)<=300 and exists(select 1 from public.booking_publications where enabled and coalesce(config->'allowedOrigins','[]'::jsonb)?p_origin)
$$;
revoke all on function public.booking_channel_origin_allowed(text) from public;
grant execute on function public.booking_channel_origin_allowed(text) to novalure_tenant_app;
-- Migration owner visibility for these narrow functions only. No runtime table privilege is added.
-- This also works when the schema owner is subject to FORCE RLS and has no BYPASSRLS attribute.
do $channel_owner_policy$
declare relation_name text;
begin
 foreach relation_name in array array['crm_service_principals','knowledge_assistant_service_bindings','bots','external_integrations','external_chat_sessions','studio_enquiry_transfers','leads'] loop
  execute format($policy$create policy booking_channel_owner_read on public.%I for select to %I
    using(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid))$policy$,relation_name,current_user);
  execute format($policy$create policy booking_channel_owner_lock on public.%I for update to %I
    using(public.booking_actor_allowed(workspace_id,nullif(current_setting('app.actor_id',true),'')::uuid))
    with check(false)$policy$,relation_name,current_user);
 end loop;
end $channel_owner_policy$;
-- Uses only the already verified, immutable session binding; no caller-supplied principal is accepted.
create function public.booking_channel_upstream_allowed(p_session uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare s record;grant_config jsonb;principal record;related_contact uuid;
begin
 select * into s from public.booking_channel_sessions where id=p_session and public.booking_actor_allowed(workspace_id,organizer_id);
 if not found then return false; end if;
 if s.binding_id is null then return s.channel not in ('chat','voice'); end if;
 if s.binding_id!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return false; end if;
 if s.relation->>'source'='machine' and s.relation->>'sourceId'=s.binding_id and s.channel in ('chat','voice') then
  select p.* into principal from public.crm_service_principals p join public.workspace_users member on member.workspace_id=p.workspace_id and member.id=p.actor_user_id
  where p.id=s.binding_id::uuid and p.workspace_id=s.workspace_id and p.state='ACTIVE' and p.revoked_at is null and not p.kill_switch_active
  and p.not_before<=clock_timestamp() and p.expires_at>clock_timestamp() and p.auth_type='VERCEL_OIDC' and p.environment='production' and p.service_role='Evelyn.Service' and p.consumer='EVELYN'
  and member.status='active' and member.role='agent' and member.product_role in ('project_sales_member','novalure_operator') for share of p,member;
  if not found then return false; end if;
  if not exists(select 1 from public.crm_authenticate_machine(principal.identity_id,principal.service_subject,principal.issuer,principal.audience,principal.oidc_project_id,principal.oidc_owner_id,principal.workspace_id,principal.environment,principal.service_role)) then return false; end if;
  select bot.config->'booking' into grant_config from public.knowledge_assistant_service_bindings binding join public.bots bot on bot.id=binding.bot_id and bot.workspace_id=binding.workspace_id
  where binding.principal_id=principal.id and binding.workspace_id=s.workspace_id and binding.channel=case s.channel when 'chat' then 'webchat' else 'voice' end
  and binding.enabled and binding.revoked_at is null for share of binding,bot;
 elsif s.relation->>'source'='external_chat' and s.channel='chat' and s.relation->>'sourceId'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
  select i.configuration->'booking' into grant_config from public.external_integrations i join public.external_chat_sessions chat on chat.integration_id=i.id and chat.workspace_id=i.workspace_id
  where i.id=s.binding_id::uuid and i.workspace_id=s.workspace_id and i.status='active' and i.revoked_at is null and i.mode='real_customer' and 'appointment.request'=any(i.capabilities) and s.origin=any(i.allowed_origins)
  and chat.id=(s.relation->>'sourceId')::uuid and chat.status='active' and chat.mode='real_customer' and chat.closed_at is null for share of i,chat;
 elsif s.relation->>'source'='studio_handoff' and s.channel='chat' and s.relation->>'sourceId'=s.binding_id then
  select lead.contact_id into related_contact from public.studio_enquiry_transfers transfer join public.leads lead on lead.id=transfer.lead_id and lead.workspace_id=transfer.workspace_id
  where transfer.operation_id=s.binding_id::uuid and transfer.workspace_id=s.workspace_id and transfer.state='accepted' and transfer.lead_id::text=s.relation->>'leadId'
  and coalesce(lead.contact_id::text,'')=coalesce(s.relation->>'contactId','') for share of transfer,lead;
  return found;
 else return false;
 end if;
 if coalesce(jsonb_typeof(grant_config),'')<>'object' or coalesce(jsonb_typeof(grant_config->'channels'),'')<>'array' or coalesce(jsonb_typeof(grant_config->'typeIds'),'')<>'array' then return false; end if;
 if jsonb_array_length(grant_config->'typeIds') not between 1 and 50 or exists(select 1 from jsonb_array_elements(grant_config->'typeIds') item where jsonb_typeof(item)<>'string' or (item#>>'{}')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then return false; end if;
 return grant_config->'enabled'='true'::jsonb and grant_config->>'publicId'=(select public_id from public.booking_publications where id=s.publication_id)
 and grant_config->'channels'?s.channel and grant_config->'typeIds'?s.assignment_id::text;
end $$;
revoke all on function public.booking_channel_upstream_allowed(uuid) from public,novalure_app,novalure_tenant_app;

-- Rechecked inside the existing engine's authoritative claim transaction and immediately before provider mutation.
-- Caller holds the workspace shared advisory lock; publication saves take its exclusive counterpart first.
create function public.booking_channel_authorize_session(p_session uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform 1 from public.booking_channel_sessions s
 join public.booking_publications p on p.id=s.publication_id and p.workspace_id=s.workspace_id
 join public.booking_publication_assignments a on a.id=s.assignment_id and a.workspace_id=s.workspace_id and a.organizer_id=s.organizer_id
 where s.id=p_session and public.booking_actor_allowed(s.workspace_id,s.organizer_id)
 and s.revoked_at is null and s.expires_at>now() and p.enabled and a.enabled and p.revision=s.publication_revision
 and coalesce((p.config->'channels'->>s.channel)::boolean,false)
 for share of p,a;
 return found and public.booking_channel_upstream_allowed(p_session);
end $$;
revoke all on function public.booking_channel_authorize_session(uuid) from public;
grant execute on function public.booking_channel_authorize_session(uuid) to novalure_tenant_app;

-- Atomic form ingestion attachment. A limited confirmed form receipt cannot grant general organizer authority.
create function public.booking_channel_attach_form_relation(p_token_hash text,p_booking uuid,p_form uuid,p_submission uuid,p_lead uuid,p_contact uuid,p_public_id text,p_workspace uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare s record;b record;f record;submission record;new_relation jsonb;
begin
 select s0.* into s from public.booking_channel_sessions s0 join public.booking_publications p on p.id=s0.publication_id and p.workspace_id=s0.workspace_id
 join public.booking_publication_assignments a on a.id=s0.assignment_id and a.workspace_id=s0.workspace_id and a.organizer_id=s0.organizer_id
 where s0.token_hash=p_token_hash and p_token_hash~'^[a-f0-9]{64}$' and s0.channel='form' and s0.binding_id is null
 and s0.workspace_id=p_workspace and p.public_id=p_public_id and s0.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
 and exists(select 1 from public.workspace_users u where u.workspace_id=s0.workspace_id and u.id=s0.organizer_id and u.status='active' and u.role in ('owner','admin','agent') and u.product_role not in ('viewer','external_partner'))
 and exists(select 1 from public.workspace_module_settings m where m.workspace_id=s0.workspace_id and m.module_key='calendar' and m.enabled)
 and s0.revoked_at is null and s0.expires_at>now() and p.enabled and a.enabled and p.revision=s0.publication_revision and (p.config->'channels'->>'form')::boolean;
 if not found then raise exception using errcode='42501',message='Form booking receipt denied'; end if;
 select * into f from public.forms where id=p_form and workspace_id=s.workspace_id and status in ('aktiv','eingebaut');
 if not found or not exists(select 1 from public.workspace_users actor where actor.workspace_id=s.workspace_id and actor.id=nullif(current_setting('app.actor_id',true),'')::uuid and actor.status='active') or not (public.crm_workspace_manager(s.workspace_id) or (f.project_id is not null and public.crm_project_access(s.workspace_id,f.project_id,true)) or (f.project_id is null and f.owner_user_id=nullif(current_setting('app.actor_id',true),'')::uuid))
 or not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(f.fields)='array' then f.fields else '[]'::jsonb end) field where field->>'type'='booking' and field->>'bookingPublicId'=(select public_id from public.booking_publications where id=s.publication_id))
 then raise exception using errcode='42501',message='Form booking scope denied'; end if;
 select * into submission from public.form_submissions where id=p_submission and workspace_id=s.workspace_id and form_id=f.id and lead_id is not distinct from p_lead and contact_id is not distinct from p_contact;
 if not found then raise exception using errcode='42501',message='Form booking relation denied'; end if;
 select * into b from public.booking_reservations where id=p_booking and workspace_id=s.workspace_id and organizer_id=s.organizer_id and state='confirmed';
 if not found or not exists(select 1 from public.booking_channel_operations where session_id=s.id and action='hold' and booking_id=b.id and state='succeeded') then raise exception using errcode='42501',message='Form booking ownership denied'; end if;
 new_relation:=jsonb_build_object('source','form_submission','sourceId',submission.id)||case when p_lead is null then '{}'::jsonb else jsonb_build_object('leadId',p_lead) end||case when p_contact is null then '{}'::jsonb else jsonb_build_object('contactId',p_contact) end;
 update public.booking_channel_sessions set relation=new_relation where id=s.id and (relation='{}'::jsonb or relation=new_relation);
 if not found then raise exception using errcode='42501',message='Form booking relation changed'; end if;
 update public.meeting_bookings set contact_id=coalesce(p_contact,contact_id),contact_name=coalesce(nullif(b.recipient_name,''),contact_name),contact_email=coalesce(b.recipient_email,contact_email),
 metadata=metadata||jsonb_build_object('bookingPublicationId',s.publication_id,'bookingChannel',s.channel,'bookingChannelSessionId',s.id,'bookingChannelRelation',new_relation),updated_at=now()
 where id=b.crm_booking_id and workspace_id=s.workspace_id and metadata->>'universalBookingId'=b.id::text;
 if not found then raise exception using errcode='42501',message='Form booking CRM mapping absent'; end if;
end $$;
revoke all on function public.booking_channel_attach_form_relation(text,uuid,uuid,uuid,uuid,uuid,text,uuid) from public;
grant execute on function public.booking_channel_attach_form_relation(text,uuid,uuid,uuid,uuid,uuid,text,uuid) to novalure_tenant_app;
