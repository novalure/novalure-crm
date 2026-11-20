-- Candidate only: not selected by the normal migration runner. No principal or
-- grant is seeded. This does not alter the existing synthetic CRM identity.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Provisioned separately, never granted to the shared tenant role. The normal
-- application database login must not be a member of this dedicated role.
do $role$
begin
  if not exists(select 1 from pg_roles where rolname='novalure_property_reader') then
    raise exception 'Dedicated property reader database role is required';
  end if;
end $role$;

create table public.crm_property_observation_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  actor_id uuid not null,
  project_id uuid not null,
  unit_id uuid not null references public.property_units(id),
  database_login name not null,
  issuer text not null check(length(issuer) between 1 and 500),
  subject text not null check(length(subject) between 1 and 500),
  audience text not null check(length(audience) between 1 and 500),
  owner_id text not null check(length(owner_id) between 1 and 200),
  workload_project_id text not null check(length(workload_project_id) between 1 and 200),
  environment text not null check(environment in ('preview','production')),
  purpose text not null check(purpose = 'property_read'),
  allowed_fields text[] not null check(cardinality(allowed_fields) between 1 and 10
    and allowed_fields <@ array['priceCents','areaSqm','rooms','status','balconyAreaSqm','terraceAreaSqm','gardenAreaSqm','undergroundParkingCount','carportCount','outdoorParkingCount']::text[]),
  valid_from timestamptz not null,
  expires_at timestamptz not null check(expires_at > valid_from),
  revoked_at timestamptz,
  kill_switch_active boolean not null default false,
  foreign key(workspace_id,actor_id) references public.workspace_users(workspace_id,id),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id)
);
create table public.crm_property_observation_audit (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.crm_property_observation_grants(id),
  workspace_id uuid not null,
  actor_id uuid not null,
  project_id uuid not null,
  unit_id uuid not null,
  requested_fields text[] not null,
  token_jti_hash text not null unique check(token_jti_hash ~ '^[a-f0-9]{64}$'),
  outcome text not null check(outcome = 'GRANT_ALLOWED'),
  occurred_at timestamptz not null default clock_timestamp()
);
alter table public.crm_property_observation_grants enable row level security;
alter table public.crm_property_observation_grants force row level security;
alter table public.crm_property_observation_audit enable row level security;
alter table public.crm_property_observation_audit force row level security;
revoke all on public.crm_property_observation_grants, public.crm_property_observation_audit from public, novalure_app, novalure_tenant_app;

-- The function owner can examine and lock grants; the runtime role gets no
-- direct grant-table access or ability to create or modify an authorization.
do $policy$
begin
  execute format('create policy crm_property_grant_owner_read on public.crm_property_observation_grants for select to %I using (true)', current_user);
  execute format('create policy crm_property_grant_owner_lock on public.crm_property_observation_grants for update to %I using (true) with check (true)', current_user);
  execute format('create policy crm_property_audit_owner_insert on public.crm_property_observation_audit for insert to %I with check (true)', current_user);
end $policy$;
create trigger crm_property_audit_immutable before update or delete or truncate on public.crm_property_observation_audit for each statement execute function public.crm_reject_immutable_mutation();

-- Authentication bootstrap returns only the one active actor bound to the
-- already verified workload identity and the exact requested object. It never
-- returns property values or an authorization without a matching grant.
create function public.crm_property_observation_actor(
  p_workspace uuid, p_project uuid, p_unit uuid,
  p_issuer text, p_subject text, p_audience text, p_owner_id text,
  p_workload_project_id text, p_environment text, p_fields text[]
) returns table(actor_id uuid) language plpgsql security definer set search_path=pg_catalog,public as $function$
declare actors uuid[];
begin
  if not pg_has_role(session_user,'novalure_property_reader','MEMBER')
     or p_workspace is null or p_project is null or p_unit is null or p_fields is null
     or cardinality(p_fields) < 1 or cardinality(p_fields) > 10
     or cardinality(p_fields) <> (select count(distinct x) from unnest(p_fields) x)
     or not (p_fields <@ array['priceCents','areaSqm','rooms','status','balconyAreaSqm','terraceAreaSqm','gardenAreaSqm','undergroundParkingCount','carportCount','outdoorParkingCount']::text[])
  then return; end if;
  select array_agg(distinct g.actor_id) into actors
    from public.crm_property_observation_grants g
    join public.workspace_users member on member.workspace_id=g.workspace_id and member.id=g.actor_id
    where g.workspace_id=p_workspace and g.project_id=p_project and g.unit_id=p_unit and g.database_login=session_user
      and g.issuer=p_issuer and g.subject=p_subject and g.audience=p_audience
      and g.owner_id=p_owner_id and g.workload_project_id=p_workload_project_id and g.environment=p_environment
      and g.purpose='property_read' and p_fields <@ g.allowed_fields
      and g.valid_from<=clock_timestamp() and g.expires_at>clock_timestamp()
      and g.revoked_at is null and not g.kill_switch_active
      and member.status='active' and member.role='agent';
  if cardinality(actors) = 1 then return query select actors[1]; end if;
end $function$;
revoke all on function public.crm_property_observation_actor(uuid,uuid,uuid,text,text,text,text,text,text,text[]) from public,novalure_app,novalure_tenant_app;
grant execute on function public.crm_property_observation_actor(uuid,uuid,uuid,text,text,text,text,text,text,text[]) to novalure_property_reader;

-- Call only with cryptographically verified identity claims. The tenant/actor
-- transaction context comes from the authenticated server session. Locks live
-- until the surrounding read transaction completes, serializing revocation.
create function public.crm_lock_property_observation_grant(
  p_workspace uuid, p_actor uuid, p_project uuid, p_unit uuid,
  p_issuer text, p_subject text, p_audience text, p_owner_id text,
  p_workload_project_id text, p_environment text, p_fields text[], p_jti_hash text, p_token_expires timestamptz
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare matched uuid; audit_id uuid; grant_expires timestamptz; effective_expires timestamptz; remaining_ms bigint;
begin
  if not pg_has_role(session_user,'novalure_property_reader','MEMBER')
     or p_workspace is null or p_actor is null or p_project is null or p_unit is null
     or p_jti_hash is null or p_jti_hash !~ '^[a-f0-9]{64}$' or p_token_expires is null or p_token_expires <= clock_timestamp()
     or p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
     or p_actor is distinct from nullif(current_setting('app.actor_id',true),'')::uuid
     or p_fields is null or cardinality(p_fields) < 1 or cardinality(p_fields) > 10
     or cardinality(p_fields) <> (select count(distinct x) from unnest(p_fields) x)
     or not (p_fields <@ array['priceCents','areaSqm','rooms','status','balconyAreaSqm','terraceAreaSqm','gardenAreaSqm','undergroundParkingCount','carportCount','outdoorParkingCount']::text[])
  then return null; end if;
  select g.id,g.expires_at into matched,grant_expires from public.crm_property_observation_grants g
    where g.workspace_id=p_workspace and g.actor_id=p_actor and g.project_id=p_project and g.unit_id=p_unit and g.database_login=session_user
      and g.issuer=p_issuer and g.subject=p_subject and g.audience=p_audience
      and g.owner_id=p_owner_id and g.workload_project_id=p_workload_project_id and g.environment=p_environment
      and g.purpose='property_read' and p_fields <@ g.allowed_fields
      and g.valid_from<=clock_timestamp() and g.expires_at>clock_timestamp()
      and g.revoked_at is null and not g.kill_switch_active
    order by g.id limit 1 for share of g;
  if matched is null or not public.crm_lock_project_access(p_workspace,p_project,false) then return null; end if;
  insert into public.crm_property_observation_audit(grant_id,workspace_id,actor_id,project_id,unit_id,requested_fields,token_jti_hash,outcome)
    values(matched,p_workspace,p_actor,p_project,p_unit,p_fields,p_jti_hash,'GRANT_ALLOWED')
    on conflict(token_jti_hash) do nothing returning id into audit_id;
  if audit_id is null then return null; end if;
  effective_expires := least(grant_expires,p_token_expires);
  remaining_ms := floor(extract(epoch from (effective_expires-clock_timestamp())) * 1000)::bigint;
  if remaining_ms <= 0 then return null; end if;
  return jsonb_build_object('grantId',matched,'remainingMs',remaining_ms);
end $function$;
revoke all on function public.crm_lock_property_observation_grant(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text[],text,timestamptz) from public,novalure_app,novalure_tenant_app;
revoke all on function public.crm_lock_property_observation_grant(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text[],text,timestamptz) from novalure_property_reader;

-- The migration owner receives a narrowly scoped SELECT policy only for this
-- exact login/grant/unit. The dedicated runtime login receives no table grants.
do $policy$
begin
  execute format($sql$create policy crm_property_observer_definer_read on public.property_units for select to %I using (
    workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and project_id=nullif(current_setting('app.property_project_id',true),'')::uuid
    and id=nullif(current_setting('app.property_unit_id',true),'')::uuid
    and public.crm_classification_allowed(workspace_id,data_classification,data_purpose)
    and exists(select 1 from public.crm_property_observation_grants g
      where g.id=nullif(current_setting('app.property_grant_id',true),'')::uuid
        and g.database_login=session_user and g.workspace_id=property_units.workspace_id
        and g.project_id=property_units.project_id and g.unit_id=property_units.id
        and g.actor_id=nullif(current_setting('app.actor_id',true),'')::uuid
        and g.revoked_at is null and not g.kill_switch_active
        and g.valid_from<=clock_timestamp() and g.expires_at>clock_timestamp())
  )$sql$,current_user);
end $policy$;

create function public.crm_property_observe_unit(
  p_workspace uuid, p_actor uuid, p_project uuid, p_unit uuid,
  p_issuer text, p_subject text, p_audience text, p_owner_id text,
  p_workload_project_id text, p_environment text, p_fields text[], p_jti_hash text, p_token_expires timestamptz
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare binding jsonb; selected record; member record; values_json jsonb := '{}'::jsonb;
begin
  if not pg_has_role(session_user,'novalure_property_reader','MEMBER') then return null; end if;
  perform set_config('app.tenant_id',p_workspace::text,true), set_config('app.actor_id',p_actor::text,true),
    set_config('app.property_project_id',p_project::text,true), set_config('app.property_unit_id',p_unit::text,true);
  select * into member from public.crm_lock_active_member(p_workspace,p_actor);
  if not found or member.role <> 'agent' or member.operating_model not in ('novalure_internal','self_service_customer','managed_by_novalure','hybrid') then return null; end if;
  binding := public.crm_lock_property_observation_grant(p_workspace,p_actor,p_project,p_unit,p_issuer,p_subject,p_audience,p_owner_id,p_workload_project_id,p_environment,p_fields,p_jti_hash,p_token_expires);
  if binding is null then return null; end if;
  perform set_config('app.property_grant_id',binding->>'grantId',true);
  select u.id,u.workspace_id,u.project_id,u.version,u.updated_at,
    case when 'priceCents'=any(p_fields) then u.price_cents else null end as price_cents,
    case when 'areaSqm'=any(p_fields) then u.area_sqm else null end as area_sqm,
    case when 'rooms'=any(p_fields) then u.rooms else null end as rooms,
    case when 'status'=any(p_fields) then u.status else null end as status
    into selected from public.property_units u where u.id=p_unit and u.workspace_id=p_workspace and u.project_id=p_project
      and public.crm_classification_allowed(u.workspace_id,u.data_classification,u.data_purpose);
  if not found then raise exception using errcode='42501',message='Property observation is not accessible'; end if;
  if 'priceCents'=any(p_fields) then values_json := values_json || jsonb_build_object('priceCents',selected.price_cents::text); end if;
  if 'areaSqm'=any(p_fields) then values_json := values_json || jsonb_build_object('areaSqm',selected.area_sqm::text); end if;
  if 'rooms'=any(p_fields) then values_json := values_json || jsonb_build_object('rooms',selected.rooms::text); end if;
  if 'status'=any(p_fields) then values_json := values_json || jsonb_build_object('status',selected.status); end if;
  return jsonb_build_object('binding',binding,'unitId',selected.id,'workspaceId',selected.workspace_id,
    'projectId',selected.project_id,'objectVersion',selected.version::text,'updatedAt',selected.updated_at,'values',values_json);
end $function$;
revoke all on function public.crm_property_observe_unit(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text[],text,timestamptz) from public,novalure_app,novalure_tenant_app;
grant execute on function public.crm_property_observe_unit(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text[],text,timestamptz) to novalure_property_reader;
