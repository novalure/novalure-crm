-- Published property websites. Public access is a revocable hashed capability,
-- never a caller-supplied workspace or lead id. No runtime role receives BYPASSRLS.
create table public.web_expose_versions (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id),
 property_id uuid not null references seller_listings(id), project_id uuid references projects(id),
 created_by uuid not null references workspace_users(id), language text not null check(language in ('de','en','es')),
 version integer not null check(version>0), snapshot jsonb not null check(snapshot->>'schemaVersion'='1'),
 source_fingerprint text not null, active boolean not null default true, created_at timestamptz not null default now(),
 unique(workspace_id,property_id,language,version), unique(workspace_id,id)
);
create table public.web_expose_links (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, version_id uuid not null,
 token_hash text not null unique check(token_hash~'^[0-9a-f]{64}$'), token_ciphertext text, label text not null check(length(label) between 1 and 200),
 intended_lead_id uuid references leads(id), expires_at timestamptz, revoked_at timestamptz,
 created_at timestamptz not null default now(), foreign key(workspace_id,version_id) references web_expose_versions(workspace_id,id),
 unique(workspace_id,id)
);
create table public.web_expose_sessions (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, link_id uuid not null,
 token_hash text not null unique check(token_hash~'^[0-9a-f]{64}$'), visitor_hash text not null check(visitor_hash~'^[0-9a-f]{64}$'),
 consent_version text not null default 'web-expose-1', consent_at timestamptz not null default now(), withdrawn_at timestamptz,
 created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 last_heartbeat_at timestamptz not null default now(), last_sequence bigint not null default 0,
 offered_sections jsonb not null default '[]' check(jsonb_typeof(offered_sections)='array'),
 foreign key(workspace_id,link_id) references web_expose_links(workspace_id,id), unique(workspace_id,id)
);
create table public.web_expose_events (
 id uuid primary key, workspace_id uuid not null, session_id uuid not null, sequence bigint not null,
 event_type text not null check(event_type in ('open','section','heartbeat','gallery','floorplan','document','external_link','pdf','video','map','cta','unit','inquiry_start')),
 section text not null check(section in ('hero','facts','description','gallery','floorplans','documents','videos','links','units','location','contact')),
 target text, active_ms integer not null default 0 check(active_ms between 0 and 10000), depth integer check(depth between 0 and 100),
 received_at timestamptz not null default now(), foreign key(workspace_id,session_id) references web_expose_sessions(workspace_id,id), unique(session_id,sequence)
);
create index web_expose_events_session on web_expose_events(session_id,received_at);
create table public.web_expose_inquiries (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, link_id uuid not null,
 request_key text not null check(length(request_key) between 16 and 128), request_hash text not null,
 network_hash text not null, email_hash text not null, lead_id uuid not null references leads(id),
 unit_id uuid references property_units(id), created_at timestamptz not null default now(),
 foreign key(workspace_id,link_id) references web_expose_links(workspace_id,id), unique(link_id,request_key)
);
create index web_expose_inquiry_limits on web_expose_inquiries(network_hash,created_at);
create table public.web_expose_outbox (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references workspaces(id), project_id uuid references projects(id),
 lead_id uuid not null references leads(id), event_type text not null check(event_type in ('new_lead','expose_opened')),
 occurred_at timestamptz not null default now(), payload jsonb not null default '{}', processed_at timestamptz
);
create index web_expose_outbox_due on web_expose_outbox(workspace_id,occurred_at) where processed_at is null;
create index web_expose_versions_property on web_expose_versions(workspace_id,property_id,created_at desc);
create index web_expose_links_version on web_expose_links(workspace_id,version_id);
create index web_expose_sessions_link on web_expose_sessions(workspace_id,link_id,created_at desc);
create index web_expose_events_workspace_session on web_expose_events(workspace_id,session_id,received_at desc);
create index web_expose_inquiries_lead on web_expose_inquiries(workspace_id,lead_id,created_at desc);
create table public.web_expose_drafts (
 workspace_id uuid not null references workspaces(id),property_id uuid not null references seller_listings(id),
 language text not null check(language in ('de','en','es')),input jsonb not null,revision integer not null default 1,
 updated_at timestamptz not null default now(),primary key(workspace_id,property_id,language)
);

create function public.crm_web_expose_access(p_workspace uuid,p_property uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(
 select 1 from public.seller_listings p where p.id=p_property and p.workspace_id=p_workspace
 and public.crm_classification_allowed(p.workspace_id,p.data_classification,p.data_purpose)
 and public.crm_project_access(p.workspace_id,p.project_id,p_write))
$$;
alter table web_expose_versions enable row level security;
alter table web_expose_versions force row level security;
alter table web_expose_drafts enable row level security;
alter table web_expose_drafts force row level security;
create policy web_drafts_read on web_expose_drafts for select to novalure_tenant_app using(crm_web_expose_access(workspace_id,property_id,false));
create policy web_drafts_write on web_expose_drafts for all to novalure_tenant_app using(crm_web_expose_access(workspace_id,property_id,true)) with check(crm_web_expose_access(workspace_id,property_id,true));
grant select,insert,update on web_expose_drafts to novalure_tenant_app;
create policy web_versions_read on web_expose_versions for select to novalure_tenant_app using(crm_web_expose_access(workspace_id,property_id,false));
create policy web_versions_insert on web_expose_versions for insert to novalure_tenant_app with check(
 crm_web_expose_access(workspace_id,property_id,true) and created_by=nullif(current_setting('app.actor_id',true),'')::uuid
 and exists(select 1 from seller_listings p where p.id=property_id and p.workspace_id=web_expose_versions.workspace_id and p.project_id is not distinct from web_expose_versions.project_id));
create policy web_versions_update on web_expose_versions for update to novalure_tenant_app using(crm_web_expose_access(workspace_id,property_id,true)) with check(crm_web_expose_access(workspace_id,property_id,true));

do $$ declare t text; begin
 foreach t in array array['web_expose_links','web_expose_sessions','web_expose_events','web_expose_inquiries','web_expose_outbox'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('alter table public.%I force row level security',t);
 end loop;
end $$;
create policy web_links_read on web_expose_links for select to novalure_tenant_app using(exists(select 1 from web_expose_versions v where v.id=version_id and v.workspace_id=web_expose_links.workspace_id) and (intended_lead_id is null or exists(select 1 from leads l where l.id=intended_lead_id and l.workspace_id=web_expose_links.workspace_id)));
create policy web_links_insert on web_expose_links for insert to novalure_tenant_app with check(
 exists(select 1 from web_expose_versions v where v.id=version_id and v.workspace_id=web_expose_links.workspace_id and crm_web_expose_access(v.workspace_id,v.property_id,true))
 and (intended_lead_id is null or exists(select 1 from leads l join web_expose_versions v on v.id=version_id and v.workspace_id=web_expose_links.workspace_id where l.id=intended_lead_id and l.workspace_id=v.workspace_id and l.project_id is not distinct from v.project_id)));
create policy web_links_update on web_expose_links for update to novalure_tenant_app using(exists(select 1 from web_expose_versions v where v.id=version_id and v.workspace_id=web_expose_links.workspace_id and crm_web_expose_access(v.workspace_id,v.property_id,true)) and (intended_lead_id is null or exists(select 1 from leads l where l.id=intended_lead_id and l.workspace_id=web_expose_links.workspace_id))) with check(exists(select 1 from web_expose_versions v where v.id=version_id and v.workspace_id=web_expose_links.workspace_id and crm_web_expose_access(v.workspace_id,v.property_id,true)));
create policy web_sessions_read on web_expose_sessions for select to novalure_tenant_app using(exists(select 1 from web_expose_links l where l.id=link_id and l.workspace_id=web_expose_sessions.workspace_id));
create policy web_events_read on web_expose_events for select to novalure_tenant_app using(exists(select 1 from web_expose_sessions s where s.id=session_id and s.workspace_id=web_expose_events.workspace_id));
create policy web_inquiries_read on web_expose_inquiries for select to novalure_tenant_app using(exists(select 1 from web_expose_links l where l.id=link_id and l.workspace_id=web_expose_inquiries.workspace_id));
create policy web_outbox_access on web_expose_outbox for all to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true) and exists(select 1 from leads l where l.id=lead_id and l.workspace_id=web_expose_outbox.workspace_id and l.project_id is not distinct from web_expose_outbox.project_id)) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));
grant select,insert on web_expose_versions,web_expose_links to novalure_tenant_app;
grant update(active) on web_expose_versions to novalure_tenant_app;
grant update(revoked_at) on web_expose_links to novalure_tenant_app;
grant select on web_expose_sessions,web_expose_events,web_expose_inquiries,web_expose_outbox to novalure_tenant_app;
grant update(processed_at) on web_expose_outbox to novalure_tenant_app;
alter table property_inquiries enable row level security;
alter table property_inquiries force row level security;
create policy web_property_inquiries_read on property_inquiries for select to novalure_tenant_app using(
 workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false)
 and exists(select 1 from seller_listings p where p.id=property_id and p.workspace_id=property_inquiries.workspace_id)
 and (lead_id is null or exists(select 1 from leads l where l.id=lead_id and l.workspace_id=property_inquiries.workspace_id))
 and (contact_id is null or exists(select 1 from contacts c where c.id=contact_id and c.workspace_id=property_inquiries.workspace_id)));
grant select on property_inquiries to novalure_tenant_app;

-- FORCE RLS also applies to a non-BYPASS migration owner inside SECURITY DEFINER.
-- Only the trusted table owner receives this path; tenant roles retain their scoped policies.
do $$ declare t text; begin
 foreach t in array array['web_expose_versions','web_expose_links','web_expose_sessions','web_expose_events','web_expose_inquiries','web_expose_outbox','seller_listings','workspace_users','workspaces','projects','property_units','contacts','leads','contact_timeline_items','media_assets','property_media','property_documents','property_inquiries'] loop
 execute format('create policy web_expose_owner_read on public.%I for select using(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)))',t,'public.'||t);
 end loop;
 foreach t in array array['web_expose_sessions','web_expose_events','web_expose_outbox','web_expose_inquiries','contacts','leads','contact_timeline_items','property_inquiries'] loop
 execute format('create policy web_expose_owner_insert on public.%I for insert with check(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)))',t,'public.'||t);
 end loop;
 create policy web_expose_owner_session_update on web_expose_sessions for update using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.web_expose_sessions'::regclass))) with check(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.web_expose_sessions'::regclass)));
 create policy web_expose_owner_link_lock on web_expose_links for update using(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.web_expose_links'::regclass))) with check(current_user=pg_get_userbyid((select relowner from pg_class where oid='public.web_expose_links'::regclass)));
 foreach t in array array['web_expose_sessions','web_expose_events','web_expose_outbox','web_expose_inquiries'] loop
 execute format('create policy web_expose_owner_delete on public.%I for delete using(current_user=pg_get_userbyid((select relowner from pg_class where oid=%L::regclass)))',t,'public.'||t);
 end loop;
end $$;

create function public.crm_web_expose_lookup(p_hash text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('versionId',v.id,'snapshot',jsonb_set(v.snapshot,'{media}',coalesce((
  select jsonb_agg(item.value order by item.ordinality)
  from jsonb_array_elements(coalesce(v.snapshot->'media','[]'::jsonb)) with ordinality item(value,ordinality)
  join property_media pm on pm.id::text=item.value->>'id' and pm.workspace_id=v.workspace_id and pm.property_id=v.property_id and pm.project_id is not distinct from v.project_id
  join media_assets a on a.id=pm.media_asset_id and a.workspace_id=v.workspace_id::text and a.id::text=item.value->>'assetId'
  where pm.unit_id is null and pm.status in('approved','published') and pm.visibility in('public','channel')
  and lower(pm.category) not in('proof','internal','contract','funding')
  and a.storage_access='private' and not a.is_public and a.public_token is null
  and a.mime_type in('image/jpeg','image/png','image/webp')
  and lower(a.folder) not like 'lead-proof-private-%' and lower(a.folder) not like 'knowledge-private-%'
  and not exists(select 1 from property_media blocked where blocked.workspace_id=v.workspace_id and blocked.media_asset_id=a.id and lower(blocked.category) in('proof','internal','contract','funding'))
  and not exists(select 1 from property_documents blocked where blocked.workspace_id=v.workspace_id and blocked.media_asset_id=a.id and blocked.category not in('expose','novalure_expose','floorplan','energy_certificate'))
 ),'[]'::jsonb)),'intendedRecipient',l.intended_lead_id is not null)
 from web_expose_links l join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id
 join seller_listings p on p.id=v.property_id and p.workspace_id=v.workspace_id and p.project_id is not distinct from v.project_id
 where l.token_hash=p_hash and p_hash~'^[0-9a-f]{64}$' and l.revoked_at is null and (l.expires_at is null or l.expires_at>clock_timestamp()) and v.active
 and p.data_classification in('CUSTOMER_TENANT','NOVALURE_INTERNAL') and p.data_purpose='crm_sales'
 and p.property_status not in('archived','error','paused') and coalesce(p.canonical_payload->'onboardingExample'->>'synthetic','false')<>'true'
 and exists(select 1 from workspace_users u where u.id=v.created_by and u.workspace_id=v.workspace_id and u.status='active')
$$;

create function public.crm_web_expose_start(p_hash text,p_session_hash text,p_visitor_hash text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare link web_expose_links; page_snapshot jsonb; resources jsonb; offered jsonb:='["hero","facts","location","contact"]'; begin
 if coalesce(p_session_hash,'')!~'^[0-9a-f]{64}$' or coalesce(p_visitor_hash,'')!~'^[0-9a-f]{64}$' then return false; end if;
 select * into link from web_expose_links where token_hash=p_hash;
 if not found then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-link:'||link.id::text,0));
 select * into link from web_expose_links where id=link.id for update;
 page_snapshot:=crm_web_expose_lookup(p_hash)->'snapshot';
 if page_snapshot is null then return false; end if;
 resources:=coalesce(page_snapshot->'resources','[]'::jsonb);
 if jsonb_array_length(resources)>0 and to_regprocedure('public.crm_web_expose_live_resources(text)') is not null then execute 'select public.crm_web_expose_live_resources($1)' into resources using p_hash; resources:=coalesce(resources,'[]'::jsonb); end if;
 if coalesce(page_snapshot->>'description','')<>'' then offered:=offered||'"description"'::jsonb; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(page_snapshot->'media','[]')) m where m->>'kind'='image') or exists(select 1 from jsonb_array_elements(resources) r where r->>'kind'='image') then offered:=offered||'"gallery"'::jsonb; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(page_snapshot->'media','[]')) m where m->>'kind'='floorplan') or exists(select 1 from jsonb_array_elements(resources) r where r->>'kind'='floorplan') then offered:=offered||'"floorplans"'::jsonb; end if;
 if exists(select 1 from jsonb_array_elements(resources) r where r->>'kind'='document') then offered:=offered||'"documents"'::jsonb; end if;
 if exists(select 1 from jsonb_array_elements(resources) r where r->>'kind'='video') then offered:=offered||'"videos"'::jsonb; end if;
 if exists(select 1 from jsonb_array_elements(resources) r where r->>'kind'='external_link') then offered:=offered||'"links"'::jsonb; end if;
 if jsonb_array_length(coalesce(page_snapshot->'units','[]'))>0 then offered:=offered||'"units"'::jsonb; end if;
 if (select count(*) from web_expose_sessions s where s.link_id=link.id and s.created_at>now()-interval '1 hour')>=500 then return false; end if;
 insert into web_expose_sessions(workspace_id,link_id,token_hash,visitor_hash,offered_sections) values(link.workspace_id,link.id,p_session_hash,encode(digest(link.workspace_id::text||':'||p_visitor_hash,'sha256'),'hex'),offered) on conflict(token_hash) do nothing;
 return true;
end $$;

create function public.crm_web_expose_withdraw(p_hash text,p_session_hash text) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare session_id_value uuid;
begin
 select s.id into session_id_value from web_expose_sessions s join web_expose_links l on l.id=s.link_id and l.workspace_id=s.workspace_id where l.token_hash=p_hash and s.token_hash=p_session_hash;
 if session_id_value is null then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-analytics-session:'||session_id_value::text,0));
 update web_expose_sessions s set withdrawn_at=coalesce(withdrawn_at,now()) from web_expose_links l
 where s.link_id=l.id and l.workspace_id=s.workspace_id and l.token_hash=p_hash and s.token_hash=p_session_hash;
 return found;
end $$;

create function public.crm_web_expose_events(p_hash text,p_session_hash text,p_events jsonb) returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare s web_expose_sessions; l web_expose_links; e jsonb; credited integer; accepted integer:=0; v_project uuid; last_visitor_heartbeat timestamptz; begin
 if jsonb_typeof(p_events) is distinct from 'array' then return 0; end if;
 if jsonb_array_length(p_events)>30 then return 0; end if;
 select * into l from web_expose_links where token_hash=p_hash;
 if not found then return 0; end if;
 select * into s from web_expose_sessions where token_hash=p_session_hash and link_id=l.id;
 if not found then return 0; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-analytics-session:'||s.id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('web-expose-link:'||l.id::text,0));
 if crm_web_expose_lookup(p_hash) is null then return 0; end if;
 select * into s from web_expose_sessions where token_hash=p_session_hash and link_id=l.id and withdrawn_at is null and created_at>clock_timestamp()-interval '24 hours' for update;
 if not found then return 0; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-visitor:'||s.workspace_id::text||s.visitor_hash,0));
 select max(last_heartbeat_at) into last_visitor_heartbeat from web_expose_sessions where workspace_id=s.workspace_id and visitor_hash=s.visitor_hash and withdrawn_at is null;
 for e in select value from jsonb_array_elements(p_events) loop
 if (e->>'sequence')::bigint<=s.last_sequence then continue; end if;
 if e->>'type' not in ('open','section','heartbeat','gallery','floorplan','document','external_link','pdf','video','map','cta','unit','inquiry_start') or e->>'section' not in ('hero','facts','description','gallery','floorplans','documents','videos','links','units','location','contact') then raise exception 'Invalid event'; end if;
 credited:=case when e->>'type'='heartbeat' then greatest(0,least(coalesce((e->>'activeMs')::integer,0),10000,(extract(epoch from clock_timestamp()-greatest(s.last_heartbeat_at,last_visitor_heartbeat))*1000)::integer)) else 0 end;
 insert into web_expose_events(id,workspace_id,session_id,sequence,event_type,section,target,active_ms,depth)
 values((e->>'id')::uuid,s.workspace_id,s.id,(e->>'sequence')::bigint,e->>'type',e->>'section',left(e->>'target',100),credited,(e->>'depth')::integer) on conflict do nothing;
 if found then
 accepted:=accepted+1; s.last_sequence:=(e->>'sequence')::bigint;
 if e->>'type'='heartbeat' then s.last_heartbeat_at:=clock_timestamp(); last_visitor_heartbeat:=s.last_heartbeat_at; end if;
 -- A qualified browser event is still only an intended-recipient attribution.
 if e->>'type'='open' and l.intended_lead_id is not null and not exists(select 1 from web_expose_events where session_id=s.id and event_type='open' and id<>(e->>'id')::uuid) then
 select project_id into v_project from web_expose_versions where id=l.version_id;
 if exists(select 1 from leads where id=l.intended_lead_id and workspace_id=s.workspace_id and project_id is not distinct from v_project) then
 insert into web_expose_outbox(workspace_id,project_id,lead_id,event_type,payload) values(s.workspace_id,v_project,l.intended_lead_id,'expose_opened',jsonb_build_object('exposeVersionId',l.version_id,'exposeSessionId',s.id,'identityLevel','intended_recipient'));
 end if; end if;
 end if;
 end loop;
 update web_expose_sessions set last_sequence=s.last_sequence,last_heartbeat_at=s.last_heartbeat_at,last_seen_at=now() where id=s.id;
 return accepted;
end $$;

create function public.crm_web_expose_inquire(p_hash text,p_key text,p_request_hash text,p_network_hash text,p_email_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare l web_expose_links; v web_expose_versions; prior web_expose_inquiries; p seller_listings; contact_id_value uuid; lead_id_value uuid; receipt_id uuid; unit_id_value uuid; begin
 select * into l from web_expose_links where token_hash=p_hash;
 if not found then return jsonb_build_object('error','unavailable'); end if;
 perform pg_advisory_xact_lock(hashtextextended('web-expose-link:'||l.id::text,0));
 select * into l from web_expose_links where id=l.id for update;
 if crm_web_expose_lookup(p_hash) is null then return jsonb_build_object('error','unavailable'); end if;
 select * into v from web_expose_versions where id=l.version_id and workspace_id=l.workspace_id;
 select * into p from seller_listings where id=v.property_id and workspace_id=v.workspace_id;
 select * into prior from web_expose_inquiries where link_id=l.id and request_key=p_key;
 if found then
 if prior.request_hash<>p_request_hash then return jsonb_build_object('error','conflict'); end if;
 return jsonb_build_object('accepted',true,'reference',prior.id);
 end if;
 if length(coalesce(p_key,'')) not between 16 and 128 or coalesce(p_request_hash,'')!~'^[0-9a-f]{64}$' or coalesce(p_network_hash,'')!~'^[0-9a-f]{64}$' or coalesce(p_email_hash,'')!~'^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object' or p_input->>'privacyRead' is distinct from 'true' or length(coalesce(p_input->>'name','')) not between 1 and 200 or length(coalesce(p_input->>'email','')) not between 3 and 254 or length(coalesce(p_input->>'message',''))>8000 then return jsonb_build_object('error','invalid'); end if;
 perform pg_advisory_xact_lock(hashtextextended('expose-inquiry:'||p_network_hash,0));
 if (select count(*) from web_expose_inquiries where (network_hash=p_network_hash or email_hash=p_email_hash) and created_at>now()-interval '1 hour')>=10 then return jsonb_build_object('error','rate_limited'); end if;
 unit_id_value:=nullif(p_input->>'unitId','')::uuid;
 if unit_id_value is not null and not exists(select 1 from jsonb_array_elements(v.snapshot->'units') u join property_units pu on pu.id=(u->>'id')::uuid and pu.workspace_id=v.workspace_id and pu.project_id=v.project_id where pu.id=unit_id_value and pu.status='available' and coalesce(pu.metadata->>'hidden','false')<>'true' and (pu.metadata->>'sellerListingId'=v.property_id::text or pu.id=p.unit_id)) then return jsonb_build_object('error','unit_unavailable'); end if;
 perform pg_advisory_xact_lock(hashtextextended(v.workspace_id::text||':'||coalesce(v.project_id::text,'')||':'||p_email_hash,0));
 select c.id into contact_id_value from contacts c where c.workspace_id=v.workspace_id and c.project_id is not distinct from v.project_id and c.data_classification is not distinct from p.data_classification and c.data_purpose is not distinct from p.data_purpose and lower(c.email)=lower(p_input->>'email') order by c.created_at limit 1;
 if contact_id_value is null then
 insert into contacts(workspace_id,project_id,name,role,email,phone,source,consent_label,owner_user_id,data_classification,data_purpose)
 values(v.workspace_id,v.project_id,p_input->>'name','Interessent',p_input->>'email',p_input->>'phone','Website','Anfrage; keine Werbeeinwilligung',v.created_by,p.data_classification,p.data_purpose) returning id into contact_id_value;
 end if;
 select id into lead_id_value from leads where workspace_id=v.workspace_id and project_id is not distinct from v.project_id and data_classification is not distinct from p.data_classification and data_purpose is not distinct from p.data_purpose and contact_id=contact_id_value and status<>'Archiviert' order by received_at desc limit 1;
 if lead_id_value is null then
 insert into leads(workspace_id,project_id,contact_id,assigned_to_user_id,source,type,status,intent,next_action,region,object_type,data_classification,data_purpose,metadata)
 values(v.workspace_id,v.project_id,contact_id_value,v.created_by,'Website','Käufer','Neu',p_input->>'message','Exposé-Anfrage beantworten',p.region,p.object_type,p.data_classification,p.data_purpose,jsonb_build_object('webExposeVersionId',v.id,'webExposeLinkId',l.id,'propertyId',v.property_id,'unitId',unit_id_value)) returning id into lead_id_value;
 insert into web_expose_outbox(workspace_id,project_id,lead_id,event_type,payload) values(v.workspace_id,v.project_id,lead_id_value,'new_lead',jsonb_build_object('exposeVersionId',v.id,'unitId',unit_id_value));
 end if;
 insert into web_expose_inquiries(workspace_id,link_id,request_key,request_hash,network_hash,email_hash,lead_id,unit_id) values(v.workspace_id,l.id,p_key,p_request_hash,p_network_hash,p_email_hash,lead_id_value,unit_id_value) returning id into receipt_id;
 insert into property_inquiries(id,workspace_id,project_id,property_id,unit_id,contact_id,lead_id,source_channel,campaign,owner_user_id,routing_reason,confidence_score,status,metadata)
 values(receipt_id,v.workspace_id,v.project_id,v.property_id,unit_id_value,contact_id_value,lead_id_value,'Website',case when l.intended_lead_id is null then l.label else 'Persönlicher Exposé-Link' end,v.created_by,'Explizite Objektanfrage über den veröffentlichten Exposé-Link',1,'routed',jsonb_build_object('source','web_expose','webExposeLinkId',l.id,'exposeVersionId',v.id));
 insert into contact_timeline_items(workspace_id,project_id,contact_id,channel,title,detail,outcome,metadata)
 values(v.workspace_id,v.project_id,contact_id_value,'Website','Exposé-Anfrage',p_input->>'message','info',jsonb_build_object('reference',receipt_id,'propertyId',v.property_id,'unitId',unit_id_value,'leadId',lead_id_value,'source','web_expose','webExposeId',v.id,'webExposeLinkId',l.id));
 return jsonb_build_object('accepted',true,'reference',receipt_id);
end $$;

create function public.crm_web_expose_asset(p_hash text,p_asset uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',m.id,'workspaceId',v.workspace_id,'name',m.name,'originalName',m.original_name,'folder',m.folder,'mimeType',m.mime_type,'sizeBytes',m.size_bytes,'relativePath',m.relative_path,'storageProvider',m.storage_provider,'storageAccess',m.storage_access,'createdAt',m.created_at,'url','', 'isPublic',false,'hasActivePublicShare',false)
 from web_expose_links l join web_expose_versions v on v.id=l.version_id and v.workspace_id=l.workspace_id
 join media_assets m on m.id=p_asset and m.workspace_id=v.workspace_id::text
 where l.token_hash=p_hash and crm_web_expose_lookup(p_hash) is not null
 and exists(select 1 from jsonb_array_elements(crm_web_expose_lookup(p_hash)->'snapshot'->'media') item where item->>'assetId'=p_asset::text)
 and exists(select 1 from property_media pm where pm.media_asset_id=m.id and pm.workspace_id=v.workspace_id and pm.property_id=v.property_id and pm.project_id is not distinct from v.project_id and pm.status in ('approved','published') and pm.visibility in ('public','channel'))
 and m.mime_type in ('image/jpeg','image/png','image/webp','application/pdf')
$$;

revoke all on function crm_web_expose_access(uuid,uuid,boolean),crm_web_expose_lookup(text),crm_web_expose_start(text,text,text),crm_web_expose_withdraw(text,text),crm_web_expose_events(text,text,jsonb),crm_web_expose_inquire(text,text,text,text,text,jsonb),crm_web_expose_asset(text,uuid) from public;
grant execute on function crm_web_expose_access(uuid,uuid,boolean) to novalure_tenant_app;
grant execute on function crm_web_expose_lookup(text),crm_web_expose_start(text,text,text),crm_web_expose_withdraw(text,text),crm_web_expose_events(text,text,jsonb),crm_web_expose_inquire(text,text,text,text,text,jsonb),crm_web_expose_asset(text,uuid) to novalure_app;
