-- Optional, manually gated successor of evelyn_autonomous_modules.sql.
-- No decision, credential, workload, grant or business action is seeded.
set local lock_timeout='5s';
set local statement_timeout='14min';

-- The protected installer must already own the bounded business tables and
-- possess authentication-metadata read/row-lock rights. Never grant those to runtime.
do $preflight$ declare t text; begin
 if current_user in('novalure_app','novalure_tenant_app') then raise exception using errcode='42501',message='Protected installer required'; end if;
 foreach t in array array['crm_offers','crm_offer_revisions','property_reservations','property_units','property_sales'] loop
  if not exists(select 1 from pg_class where oid=('public.'||t)::regclass and relowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception using errcode='42501',message='Protected business table owner required';
  end if;
 end loop;
 if not has_column_privilege(current_user,'public.auth_sessions','id','SELECT')
  or not has_column_privilege(current_user,'public.auth_sessions','last_seen_at','UPDATE')
  or not has_column_privilege(current_user,'public.auth_identities','id','SELECT')
  or not has_column_privilege(current_user,'public.auth_identities','updated_at','UPDATE') then
  raise exception using errcode='42501',message='Protected authentication metadata access required';
 end if;
end $preflight$;

create table public.crm_autonomous_business_decisions (
 id uuid primary key, grant_id uuid not null references public.crm_autonomous_access_grants(id),
 workspace_id uuid not null, project_id uuid not null, source_id uuid not null,
 operation text not null check(operation in('SendOffer','ConfirmReservation','ConfirmSale')),
 expected_version bigint not null check(expected_version>0), request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 idempotency_key uuid not null, decision text not null check(decision in('APPROVED','DENIED')),
 decided_by uuid not null, auth_identity_id uuid not null references public.auth_identities(id),
 auth_session_id uuid not null references public.auth_sessions(id),
 expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,project_id) references public.projects(workspace_id,id),
 foreign key(workspace_id,decided_by) references public.workspace_users(workspace_id,id),
 unique(id,workspace_id), check(expires_at>created_at and expires_at<=created_at+interval '24 hours')
);
create table public.crm_autonomous_business_revocations (
 decision_id uuid primary key references public.crm_autonomous_business_decisions(id), workspace_id uuid not null,
 revoked_by uuid not null, auth_session_id uuid not null references public.auth_sessions(id),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,revoked_by) references public.workspace_users(workspace_id,id)
);
create table public.crm_autonomous_business_consumptions (
 decision_id uuid primary key references public.crm_autonomous_business_decisions(id), workspace_id uuid not null,
 grant_id uuid not null references public.crm_autonomous_access_grants(id), actor_user_id uuid not null,
 idempotency_key uuid not null, request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(), unique(workspace_id,idempotency_key),
 foreign key(workspace_id,actor_user_id) references public.workspace_users(workspace_id,id)
);
create table public.crm_autonomous_offer_quality_events (
 id uuid primary key, event_type text not null check(event_type in('ATTESTED','REVOKED')),
 quality_reference uuid references public.crm_autonomous_offer_quality_events(id),
 grant_id uuid not null references public.crm_autonomous_access_grants(id), workspace_id uuid not null, project_id uuid not null,
 offer_id uuid not null, offer_version bigint not null check(offer_version>0), offer_revision integer not null check(offer_revision>0),
 content_digest text not null check(content_digest~'^[a-f0-9]{64}$'), request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 origin text not null check(origin='OWNER_QUALITY_ATTESTATION'), actor_user_id uuid not null,
 auth_identity_id uuid not null references public.auth_identities(id), auth_session_id uuid not null references public.auth_sessions(id),
 expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,project_id,offer_id,offer_revision) references public.crm_offer_revisions(workspace_id,project_id,offer_id,revision),
 check((event_type='ATTESTED' and quality_reference is null and expires_at>created_at and expires_at<=created_at+interval '24 hours')
  or(event_type='REVOKED' and quality_reference is not null))
);
do $policies$ declare t text; begin
 foreach t in array array['crm_autonomous_business_decisions','crm_autonomous_business_revocations','crm_autonomous_business_consumptions','crm_autonomous_offer_quality_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,novalure_app,novalure_tenant_app',t);
  execute format('create policy autonomous_business_protected_owner on public.%I for all to %I using(true) with check(true)',t,current_user);
  execute format('create trigger autonomous_business_immutable before update or delete or truncate on public.%I for each statement execute function public.crm_reject_immutable_mutation()',t);
 end loop;
 foreach t in array array['crm_offers','crm_offer_revisions','property_reservations','property_units','property_sales'] loop
  execute format('create policy autonomous_business_target_read on public.%I for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and data_purpose=''crm_sales'')',t,current_user);
  execute format('create policy autonomous_business_target_lock on public.%I for update to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and data_purpose=''crm_sales'') with check(false)',t,current_user);
 end loop;
end $policies$;

-- Closed guarded commands have simple scalar patch fields. This independently
-- reproduces crmPayloadDigest, rather than trusting a submitted hash or JSONB whitespace.
create function public.crm_autonomous_business_body_hash(b jsonb) returns text
language plpgsql immutable strict set search_path=pg_catalog,public as $function$
declare p jsonb; patch_text text; n numeric; begin
 if jsonb_typeof(b)<>'object' or (select count(*) from jsonb_object_keys(b))<>6
  or not b ?& array['contractVersion','operation','correlationId','idempotencyKey','expectedVersion','patch']
  or b->>'contractVersion'<>'crm-autonomous-access-v2' or b->>'operation' not in('SendOffer','ConfirmReservation','ConfirmSale')
  or jsonb_typeof(b->'expectedVersion')<>'number' or (b->>'expectedVersion')!~'^[1-9][0-9]{0,15}$'
  or (b->>'correlationId')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  or (b->>'idempotencyKey')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then
  raise exception using errcode='42501',message='Invalid guarded command'; end if;
 n=(b->>'expectedVersion')::numeric;
 if n>9007199254740991 then raise exception using errcode='42501',message='Invalid guarded command'; end if;
 p=b->'patch';
 if jsonb_typeof(p)<>'object' then raise exception using errcode='42501',message='Invalid guarded command'; end if;
 if b->>'operation'='SendOffer' then
  if p<>'{}'::jsonb then raise exception using errcode='42501',message='Invalid guarded command'; end if;
  patch_text='{}';
 else
  if (select count(*) from jsonb_object_keys(p))<>3 or not p ?& array['approvalReference','unitVersion','sourceReference']
   or (p->>'approvalReference')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   or jsonb_typeof(p->'unitVersion')<>'number' or (p->>'unitVersion')!~'^[1-9][0-9]{0,15}$'
   or jsonb_typeof(p->'sourceReference')<>'string' or length(btrim(p->>'sourceReference')) not between 1 and 500
   or (p->>'sourceReference') ~ '[[:cntrl:]]' then raise exception using errcode='42501',message='Invalid guarded command'; end if;
  if (p->>'unitVersion')::numeric>9007199254740991 then raise exception using errcode='42501',message='Invalid guarded command'; end if;
  patch_text='{"approvalReference":'||(p->'approvalReference')::text||',"sourceReference":'||(p->'sourceReference')::text||',"unitVersion":'||(p->'unitVersion')::text||'}';
 end if;
 return encode(public.digest(convert_to('{"contractVersion":'||(b->'contractVersion')::text||',"correlationId":'||(b->'correlationId')::text
  ||',"expectedVersion":'||(b->'expectedVersion')::text||',"idempotencyKey":'||(b->'idempotencyKey')::text
  ||',"operation":'||(b->'operation')::text||',"patch":'||patch_text||'}','UTF8'),'sha256'),'hex');
end $function$;

create function public.crm_autonomous_business_owner(p_session uuid,p_identity uuid) returns uuid
language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
declare owner_id uuid; begin
 select u.id into owner_id from public.workspace_users u join public.workspaces w on w.id=u.workspace_id
 join public.auth_sessions s on s.workspace_id=u.workspace_id and s.workspace_user_id=u.id and s.auth_identity_id=u.auth_identity_id
 join public.auth_identities i on i.id=u.auth_identity_id
 where w.id=nullif(current_setting('app.tenant_id',true),'')::uuid and w.operating_model='novalure_internal'
  and u.id=nullif(current_setting('app.actor_id',true),'')::uuid and u.id::text=w.setup_state->>'salesApprovalUserId'
  and u.role='owner' and u.status='active' and s.id=p_session and i.id=p_identity
  and i.credential_state='active' and i.disabled_at is null and i.mfa_enabled_at is not null
  and i.normalized_email=lower(btrim(u.email)) and s.revoked_at is null and s.expires_at>clock_timestamp()
  and s.created_at<=clock_timestamp() and s.created_at>=clock_timestamp()-interval '15 minutes'
  and s.mfa_verified_at<=clock_timestamp() and s.mfa_verified_at>=clock_timestamp()-interval '15 minutes'
 for share of u,w,s,i;
 if owner_id is null then raise exception using errcode='42501',message='Fresh configured owner authentication required'; end if;
 return owner_id;
end $function$;

create function public.crm_autonomous_business_grant(p_grant uuid) returns public.crm_autonomous_access_grants
language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
declare g public.crm_autonomous_access_grants; begin
 select a.* into g from public.crm_autonomous_access_grants a join public.crm_autonomous_workloads w on w.id=a.workload_id and w.workspace_id=a.workspace_id
 join public.workspace_users u on u.id=a.actor_user_id and u.workspace_id=a.workspace_id
 where a.id=p_grant and a.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  and a.contract_version='crm-autonomous-access-v2' and a.authority_class='REAL_INTERNAL_OPERATIONS'
  and not a.disabled and a.revoked_at is null and a.not_before<=clock_timestamp() and (a.expires_at is null or a.expires_at>clock_timestamp())
  and not w.disabled and not w.kill_switch_active and w.revoked_at is null and w.not_before<=clock_timestamp() and (w.expires_at is null or w.expires_at>clock_timestamp())
  and u.status='active' and u.role='agent' and u.product_role='novalure_operator'
  and exists(select 1 from public.project_pipeline_permissions pp where pp.workspace_id=a.workspace_id and pp.project_id=a.project_id and pp.user_id=a.actor_user_id and pp.can_read and pp.can_edit_deals)
 for share of a,w,u;
 if g.id is null then raise exception using errcode='42501',message='Current autonomous assignment required'; end if;
 return g;
end $function$;

-- Match the native existing-offer command lock: current offer. Revisions
-- are immutable; a changed revision/digest invalidates an old quality assertion.
create function public.crm_autonomous_business_offer_state(g public.crm_autonomous_access_grants)
returns table(version bigint,revision integer,content_digest text)
language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
begin
 return query select o.version::bigint,o.revision,r.content_digest from public.crm_offers o join public.crm_offer_revisions r
  on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
  where o.id=g.source_id and o.workspace_id=g.workspace_id and o.project_id=g.project_id
   and o.data_classification='NOVALURE_INTERNAL' and o.data_purpose='crm_sales'
   and r.data_classification='NOVALURE_INTERNAL' and r.data_purpose='crm_sales' for update of o;
end $function$;

create function public.crm_autonomous_business_version(g public.crm_autonomous_access_grants,b jsonb) returns bigint
language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
declare v bigint; r uuid; u uuid; uv bigint; begin
 if b->>'operation'='SendOffer' and g.entity='Offer' and 'crm.offers.send'=any(g.scopes) then
  select state.version into v from public.crm_autonomous_business_offer_state(g) state;
 elsif ((b->>'operation'='ConfirmReservation' and g.entity='Reservation' and 'crm.reservations.confirm'=any(g.scopes))
  or (b->>'operation'='ConfirmSale' and g.entity='Sale' and 'crm.sales.confirm'=any(g.scopes))) then
  r=case when g.entity='Reservation' then g.source_id else (g.related_resources->>'reservationId')::uuid end;
  -- Existing native reservation commands lock reservation, then its unit.
  select unit_id,version into u,v from public.property_reservations where id=r and workspace_id=g.workspace_id and project_id=g.project_id
   and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' for update;
  if u is distinct from (g.related_resources->>'unitId')::uuid then raise exception using errcode='42501',message='Commercial relationship differs'; end if;
  select version into uv from public.property_units where id=u and workspace_id=g.workspace_id and project_id=g.project_id and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' for update;
  if uv is distinct from (b->'patch'->>'unitVersion')::bigint then raise exception using errcode='40001',message='Commercial unit version differs'; end if;
 else raise exception using errcode='42501',message='Guarded action is not assigned'; end if;
 if v is null or v<>(b->>'expectedVersion')::bigint then raise exception using errcode='40001',message='Commercial resource version differs'; end if;
 return v;
end $function$;

create function public.crm_decide_autonomous_business(p_session uuid,p_identity uuid,p_id uuid,p_grant uuid,b jsonb,p_hash text,p_decision text,p_expires timestamptz)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
declare g public.crm_autonomous_access_grants; owner_id uuid; existing public.crm_autonomous_business_decisions; begin
 if p_hash is distinct from public.crm_autonomous_business_body_hash(b) or p_decision not in('APPROVED','DENIED')
  or p_expires<=clock_timestamp() or p_expires>clock_timestamp()+interval '24 hours' then raise exception using errcode='42501',message='Invalid owner decision'; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm-command:'||current_setting('app.tenant_id')||':'||(b->>'idempotencyKey'),0));
 owner_id=public.crm_autonomous_business_owner(p_session,p_identity);
 g=public.crm_autonomous_business_grant(p_grant);
 perform pg_advisory_xact_lock(hashtextextended('autonomous-business:'||p_id::text,0));
 if b->>'operation'<>'SendOffer' and (b->'patch'->>'approvalReference')::uuid<>p_id then raise exception using errcode='42501',message='Decision reference differs'; end if;
 select * into existing from public.crm_autonomous_business_decisions where id=p_id;
 if found then
  if existing.grant_id=p_grant and existing.request_hash=p_hash and existing.decision=p_decision and existing.decided_by=owner_id
   and existing.auth_identity_id=p_identity and existing.expires_at=p_expires then return existing.id; end if;
  raise exception using errcode='42501',message='Decision identity is already bound';
 end if;
 perform public.crm_autonomous_business_version(g,b);
 insert into public.crm_autonomous_business_decisions(id,grant_id,workspace_id,project_id,source_id,operation,expected_version,request_hash,idempotency_key,decision,decided_by,auth_identity_id,auth_session_id,expires_at)
 values(p_id,g.id,g.workspace_id,g.project_id,g.source_id,b->>'operation',(b->>'expectedVersion')::bigint,p_hash,(b->>'idempotencyKey')::uuid,p_decision,owner_id,p_identity,p_session,p_expires);
 return p_id;
end $function$;

create function public.crm_revoke_autonomous_business(p_session uuid,p_identity uuid,p_id uuid) returns uuid
language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
declare owner_id uuid; d public.crm_autonomous_business_decisions; begin
 owner_id=public.crm_autonomous_business_owner(p_session,p_identity);
 perform pg_advisory_xact_lock(hashtextextended('autonomous-business:'||p_id::text,0));
 select * into d from public.crm_autonomous_business_decisions where id=p_id and workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 if not found then raise exception using errcode='42501',message='Decision unavailable'; end if;
 insert into public.crm_autonomous_business_revocations(decision_id,workspace_id,revoked_by,auth_session_id)
 values(d.id,d.workspace_id,owner_id,p_session) on conflict(decision_id) do nothing;
 return d.id;
end $function$;

create function public.crm_attest_autonomous_offer_quality(p_session uuid,p_identity uuid,p_id uuid,p_grant uuid,b jsonb,p_hash text,p_expires timestamptz)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
declare g public.crm_autonomous_access_grants; owner_id uuid; state record; existing public.crm_autonomous_offer_quality_events; begin
 if b->>'operation'<>'SendOffer' or p_hash is distinct from public.crm_autonomous_business_body_hash(b)
  or p_expires<=clock_timestamp() or p_expires>clock_timestamp()+interval '24 hours' then raise exception using errcode='42501',message='Invalid quality attestation'; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm-command:'||current_setting('app.tenant_id')||':'||(b->>'idempotencyKey'),0));
 owner_id=public.crm_autonomous_business_owner(p_session,p_identity);
 g=public.crm_autonomous_business_grant(p_grant);
 perform public.crm_autonomous_business_version(g,b);
 select * into state from public.crm_autonomous_business_offer_state(g);
 perform pg_advisory_xact_lock(hashtextextended('autonomous-offer-quality:'||p_id::text,0));
 select * into existing from public.crm_autonomous_offer_quality_events where id=p_id;
 if found then
  if existing.event_type='ATTESTED' and existing.grant_id=g.id and existing.request_hash=p_hash and existing.actor_user_id=owner_id
   and existing.offer_version=(b->>'expectedVersion')::bigint and existing.offer_revision=state.revision
   and existing.content_digest=state.content_digest and existing.expires_at=p_expires then return existing.id; end if;
  raise exception using errcode='42501',message='Quality identity is already bound';
 end if;
 insert into public.crm_autonomous_offer_quality_events(id,event_type,grant_id,workspace_id,project_id,offer_id,offer_version,offer_revision,content_digest,request_hash,origin,actor_user_id,auth_identity_id,auth_session_id,expires_at)
 values(p_id,'ATTESTED',g.id,g.workspace_id,g.project_id,g.source_id,(b->>'expectedVersion')::bigint,state.revision,state.content_digest,p_hash,'OWNER_QUALITY_ATTESTATION',owner_id,p_identity,p_session,p_expires);
 return p_id;
end $function$;

create function public.crm_revoke_autonomous_offer_quality(p_session uuid,p_identity uuid,p_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
declare owner_id uuid; q public.crm_autonomous_offer_quality_events; begin
 owner_id=public.crm_autonomous_business_owner(p_session,p_identity);
 perform pg_advisory_xact_lock(hashtextextended('autonomous-offer-quality:'||p_id::text,0));
 select * into q from public.crm_autonomous_offer_quality_events where id=p_id and event_type='ATTESTED'
  and workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid;
 if not found then raise exception using errcode='42501',message='Quality attestation unavailable'; end if;
 if not exists(select 1 from public.crm_autonomous_offer_quality_events where quality_reference=q.id and event_type='REVOKED') then
  insert into public.crm_autonomous_offer_quality_events(id,event_type,quality_reference,grant_id,workspace_id,project_id,offer_id,offer_version,offer_revision,content_digest,request_hash,origin,actor_user_id,auth_identity_id,auth_session_id,expires_at)
  values(gen_random_uuid(),'REVOKED',q.id,q.grant_id,q.workspace_id,q.project_id,q.offer_id,q.offer_version,q.offer_revision,q.content_digest,q.request_hash,'OWNER_QUALITY_ATTESTATION',owner_id,p_identity,p_session,q.expires_at);
 end if;
 return q.id;
end $function$;

create function public.crm_consume_autonomous_business(p_grant uuid,b jsonb,p_hash text)
returns table(approval_reference uuid,replayed boolean,quality_reference uuid,quality_origin text) language plpgsql volatile security definer set search_path=pg_catalog,public as $function$
declare g public.crm_autonomous_access_grants; d public.crm_autonomous_business_decisions; c public.crm_autonomous_business_consumptions; q public.crm_autonomous_offer_quality_events; state record; begin
 if p_hash is distinct from public.crm_autonomous_business_body_hash(b) then raise exception using errcode='42501',message='Guarded command hash differs'; end if;
 perform pg_advisory_xact_lock(hashtextextended('crm-command:'||current_setting('app.tenant_id')||':'||(b->>'idempotencyKey'),0));
 -- Acquire the EXISTING complete delegation chain in its canonical total order,
 -- before any child-specific business lock. No new service grant resolver.
 select live.* into g from public.crm_autonomous_access_grants saved
 cross join lateral public.crm_lock_autonomous_access_grant(saved.workload_id,saved.id) live where saved.id=p_grant;
 if g.id is null or g.contract_version<>'crm-autonomous-access-v2' then raise exception using errcode='42501',message='Current autonomous assignment required'; end if;
 if g.actor_user_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid then raise exception using errcode='42501',message='Autonomous actor differs'; end if;
 select a.* into d from public.crm_autonomous_business_decisions a
 where a.grant_id=g.id and a.workspace_id=g.workspace_id and a.project_id=g.project_id and a.source_id=g.source_id
  and a.operation=b->>'operation' and a.expected_version=(b->>'expectedVersion')::bigint and a.request_hash=p_hash
  and a.idempotency_key=(b->>'idempotencyKey')::uuid and a.decision='APPROVED'
  and (b->>'operation'='SendOffer' or a.id=(b->'patch'->>'approvalReference')::uuid)
 order by a.created_at desc,a.id limit 1;
 if d.id is null then raise exception using errcode='42501',message='Business approval required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('autonomous-business:'||d.id::text,0));
 if d.expires_at<=clock_timestamp() or exists(select 1 from public.crm_autonomous_business_revocations r where r.decision_id=d.id)
  then raise exception using errcode='42501',message='Business approval no longer active'; end if;
 perform u.id from public.workspace_users u join public.workspaces w on w.id=u.workspace_id join public.auth_identities i on i.id=u.auth_identity_id
  where u.id=d.decided_by and u.workspace_id=d.workspace_id and u.status='active' and u.role='owner' and u.id::text=w.setup_state->>'salesApprovalUserId'
   and i.id=d.auth_identity_id and i.disabled_at is null and i.credential_state='active' for share of u,w,i;
 if not found then raise exception using errcode='42501',message='Business owner authority changed'; end if;
 if b->>'operation'='SendOffer' then
  select * into state from public.crm_autonomous_business_offer_state(g);
  select e.* into q from public.crm_autonomous_offer_quality_events e where e.event_type='ATTESTED' and e.grant_id=g.id
   and e.workspace_id=g.workspace_id and e.project_id=g.project_id and e.offer_id=g.source_id
   and e.offer_version=d.expected_version and e.offer_revision=state.revision and e.content_digest=state.content_digest
   and e.request_hash=p_hash and e.actor_user_id=d.decided_by and e.auth_identity_id=d.auth_identity_id
   and not exists(select 1 from public.crm_autonomous_offer_quality_events r where r.quality_reference=e.id and r.event_type='REVOKED')
   order by e.created_at desc,e.id limit 1;
  if q.id is null then raise exception using errcode='42501',message='Explicit owner offer quality attestation required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('autonomous-offer-quality:'||q.id::text,0));
  if q.expires_at<=clock_timestamp() or exists(select 1 from public.crm_autonomous_offer_quality_events r where r.quality_reference=q.id and r.event_type='REVOKED')
   then raise exception using errcode='42501',message='Offer quality attestation no longer active'; end if;
 end if;
 select * into c from public.crm_autonomous_business_consumptions where decision_id=d.id;
 if found then
  if c.workspace_id=g.workspace_id and c.grant_id=g.id and c.actor_user_id=g.actor_user_id and c.idempotency_key=(b->>'idempotencyKey')::uuid and c.request_hash=p_hash then return query select d.id,true,q.id,q.origin; return; end if;
  raise exception using errcode='42501',message='Business approval already consumed';
 end if;
 perform public.crm_autonomous_business_version(g,b);
 insert into public.crm_autonomous_business_consumptions(decision_id,workspace_id,grant_id,actor_user_id,idempotency_key,request_hash)
 values(d.id,g.workspace_id,g.id,g.actor_user_id,(b->>'idempotencyKey')::uuid,p_hash);
 return query select d.id,false,q.id,q.origin;
end $function$;

revoke all on function public.crm_autonomous_business_body_hash(jsonb),public.crm_autonomous_business_owner(uuid,uuid),
 public.crm_autonomous_business_grant(uuid),public.crm_autonomous_business_version(public.crm_autonomous_access_grants,jsonb),
 public.crm_autonomous_business_offer_state(public.crm_autonomous_access_grants),
 public.crm_attest_autonomous_offer_quality(uuid,uuid,uuid,uuid,jsonb,text,timestamptz),public.crm_revoke_autonomous_offer_quality(uuid,uuid,uuid),
 public.crm_decide_autonomous_business(uuid,uuid,uuid,uuid,jsonb,text,text,timestamptz),public.crm_revoke_autonomous_business(uuid,uuid,uuid),
 public.crm_consume_autonomous_business(uuid,jsonb,text) from public,novalure_app,novalure_tenant_app;
grant execute on function public.crm_decide_autonomous_business(uuid,uuid,uuid,uuid,jsonb,text,text,timestamptz),
 public.crm_attest_autonomous_offer_quality(uuid,uuid,uuid,uuid,jsonb,text,timestamptz),public.crm_revoke_autonomous_offer_quality(uuid,uuid,uuid),
 public.crm_revoke_autonomous_business(uuid,uuid,uuid),public.crm_consume_autonomous_business(uuid,jsonb,text) to novalure_tenant_app;
