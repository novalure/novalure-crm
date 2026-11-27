-- Stage only. Installs no activation, SOURCE credential, deployment or grant.
set local lock_timeout = '5s';
set local statement_timeout = '2min';
do $guard$
declare r pg_roles;
begin
  select * into strict r from pg_roles where rolname = current_user;
  if r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication
    or not exists (select 1 from pg_class where oid = 'public.studio_enquiry_transfers'::regclass and relowner = r.oid)
    or to_regprocedure('public.crm_authenticate_autonomous_workload(text,text,text,text,text,uuid,text)') is null
  then raise exception 'STUDIO_SOURCE_INSTALLER_BOUNDARY' using errcode = '42501'; end if;
end
$guard$;

create sequence public.crm_studio_source_seq as bigint cache 1;
alter table public.studio_enquiry_transfers add column source_seq bigint
  check (source_seq is null or (source_seq > 0 and state = 'accepted'));
create unique index crm_studio_source_sequence on public.studio_enquiry_transfers (workspace_id, source_seq)
  where state = 'accepted' and source_seq is not null;

create function public.crm_studio_source_sequence() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $body$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'reserved' or new.source_seq is not null then
      raise exception 'STUDIO_SOURCE_RESERVATION_REQUIRED' using errcode = '42501';
    end if;
  elsif new.source_seq is distinct from old.source_seq then
    raise exception 'STUDIO_SOURCE_SEQUENCE_IMMUTABLE' using errcode = '42501';
  elsif old.state = 'reserved' and new.state = 'accepted' then
    -- Finalize already holds this lock. Keep every accepted transition and
    -- activation serialized on it, including a future authorized DB caller.
    perform pg_advisory_xact_lock(hashtextextended('studio-enquiry-media-quota:' || new.workspace_id::text, 0));
    new.source_seq := nextval('public.crm_studio_source_seq'::regclass);
  end if;
  return new;
end
$body$;
create trigger studio_enquiry_source_sequence before insert or update on public.studio_enquiry_transfers
  for each row execute function public.crm_studio_source_sequence();

create table public.crm_studio_source_activation (
  singleton boolean primary key default true check (singleton),
  profile text not null check (profile in ('production', 'preview')),
  database_project text not null,
  database_branch text not null,
  starts_after bigint not null check (starts_after >= 0),
  activated_at timestamptz not null,
  cursor_key bytea not null check (octet_length(cursor_key) = 32)
);
create table public.crm_studio_source_grants (
  id uuid primary key,
  profile text not null check (profile in ('production', 'preview')),
  workload_id uuid,
  workspace_id uuid not null check (workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'),
  crm_project_id uuid not null check (crm_project_id = 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2'),
  receiver_project text not null check (receiver_project = 'prj_R32Okl6AHijTohvuKmryuTLjWMsk'),
  deployment_id text not null check (deployment_id ~ '^dpl_[a-zA-Z0-9]+$'),
  revision text not null check (revision ~ '^[0-9a-f]{40}$'),
  credential_hash text not null unique check (credential_hash ~ '^[0-9a-f]{64}$'),
  authority_reference text not null check (length(btrim(authority_reference)) between 1 and 200),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check ((profile = 'production') = (workload_id is not null))
);

do $policies$
declare t text;
begin
  foreach t in array array['crm_studio_source_activation','crm_studio_source_grants'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy studio_source_owner on public.%I to %I using (true) with check (true)', t, current_user);
    execute format('revoke all on public.%I from public, novalure_app, novalure_tenant_app', t);
  end loop;
end
$policies$;

create function public.crm_studio_source_activate() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $body$
begin
  if tg_op <> 'INSERT' then raise exception 'STUDIO_SOURCE_ACTIVATION_IMMUTABLE' using errcode = '42501'; end if;
  new.database_project := current_setting('neon.project_id', true);
  new.database_branch := current_setting('neon.branch_id', true);
  if current_database() <> 'neondb' or not coalesce(
    (new.profile = 'production' and new.database_project = 'misty-cloud-70835427' and new.database_branch = 'br-spring-night-alyu48yp')
    or (new.profile = 'preview' and new.database_project = 'long-fog-84900593' and new.database_branch = 'br-summer-mountain-bh7w67e3'), false)
  then raise exception 'STUDIO_SOURCE_ACTIVATION_TARGET' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('studio-enquiry-media-quota:8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 0));
  select case when is_called then last_value else 0 end into new.starts_after from public.crm_studio_source_seq;
  new.activated_at := clock_timestamp();
  new.cursor_key := public.gen_random_bytes(32);
  return new;
end
$body$;
create trigger crm_studio_source_activate before insert or update or delete on public.crm_studio_source_activation
  for each row execute function public.crm_studio_source_activate();
create trigger crm_studio_source_keep_activation before truncate on public.crm_studio_source_activation
  for each statement execute function public.crm_studio_source_activate();

create function public.crm_studio_source_revoke() returns trigger
language plpgsql set search_path = pg_catalog as $body$
begin
  if tg_op <> 'UPDATE' or old.revoked_at is not null or new.revoked_at is null
    or (to_jsonb(new) - 'revoked_at') is distinct from (to_jsonb(old) - 'revoked_at')
  then raise exception 'STUDIO_SOURCE_GRANT_IMMUTABLE' using errcode = '42501'; end if;
  new.revoked_at := clock_timestamp();
  return new;
end
$body$;
create trigger crm_studio_source_revoke before update or delete on public.crm_studio_source_grants
  for each row execute function public.crm_studio_source_revoke();
create trigger crm_studio_source_keep_grants before truncate on public.crm_studio_source_grants
  for each statement execute function public.crm_studio_source_revoke();

-- With no last position, validate the incoming cursor and return the durable
-- start/position. With a last position, seal only forward progress. The secret
-- remains in the installer-owned activation and never reaches the HTTP runtime.
create function public.crm_studio_source_position(
  p_profile text, p_workload uuid, p_deployment text, p_revision text,
  p_credential_hash text, p_cursor text, p_last bigint default null
) returns table (grant_id uuid, after_seq bigint, next_cursor text)
language plpgsql stable security definer set search_path = pg_catalog, public as $body$
declare a public.crm_studio_source_activation; binding uuid; position bigint; prefix text; tag text;
begin
  if current_setting('app.tenant_id', true) is distinct from '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
    or current_setting('app.actor_id', true) is distinct from '6122a6da-e7f4-47fa-bc55-e296bb01af62'
    or current_setting('transaction_read_only') <> 'on'
    or session_user <> 'novalure_app' or current_database() <> 'neondb'
  then return; end if;
  select ac.* into a from public.crm_studio_source_activation ac
    where ac.profile = p_profile and ac.database_project = current_setting('neon.project_id', true)
      and ac.database_branch = current_setting('neon.branch_id', true);
  if not found then return; end if;
  select g.id into binding from public.crm_studio_source_grants g
    where g.profile = p_profile and g.workload_id is not distinct from p_workload
      and g.deployment_id = p_deployment and g.revision = p_revision and g.credential_hash = p_credential_hash
      and g.revoked_at is null and g.expires_at > clock_timestamp();
  if not found then return; end if;
  prefix := 'studio-source-v1:' || p_profile || ':' || coalesce(p_workload::text, '-') || ':';
  position := a.starts_after;
  if p_cursor is not null then
    if p_cursor !~ '^(0|[1-9][0-9]{0,18})\.[a-f0-9]{64}$' then return; end if;
    begin position := split_part(p_cursor, '.', 1)::bigint;
    exception when numeric_value_out_of_range then return; end;
    tag := encode(public.hmac(convert_to(prefix || position::text, 'UTF8'), a.cursor_key, 'sha256'), 'hex');
    if position < a.starts_after or tag <> split_part(p_cursor, '.', 2) then return; end if;
  end if;
  if p_last is not null and p_last <= position then return; end if;
  return query select binding, position, case when p_last is not null then p_last::text || '.' ||
    encode(public.hmac(convert_to(prefix || p_last::text, 'UTF8'), a.cursor_key, 'sha256'), 'hex') end;
end
$body$;

-- The protected Sales command uses a different tenant actor. Only the bounded
-- installer-owned verifier may test an exact Studio receipt without switching
-- that Sales transaction to the Studio intake actor.
do $policy$
begin
  execute format(
    'create policy studio_source_receipt_owner on public.studio_enquiry_transfers for select to %I
      using (workspace_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid and state = ''accepted'')',
    current_user);
end
$policy$;

create function public.crm_studio_source_transfer_matches(
  p_workload uuid, p_grant uuid, p_workspace uuid, p_project uuid,
  p_operation uuid, p_revision integer, p_payload_hash text, p_lead uuid, p_submission uuid
) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, public as $body$
declare boundary bigint; binding uuid;
begin
  if p_workspace is distinct from '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    or p_project is distinct from 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2'::uuid
    or p_workspace is distinct from nullif(current_setting('app.tenant_id', true),'')::uuid
    or nullif(current_setting('app.actor_id', true),'') is null or session_user <> 'novalure_app'
  then return false; end if;
  select a.starts_after into boundary from public.crm_studio_source_activation a
    where a.profile = 'production' and a.database_project = current_setting('neon.project_id', true)
      and a.database_branch = current_setting('neon.branch_id', true);
  if not found then return false; end if;
  select g.id into binding from public.crm_studio_source_grants g
    where g.id = p_grant and g.workload_id = p_workload and g.profile = 'production'
      and g.workspace_id = p_workspace and g.crm_project_id = p_project and g.revoked_at is null
    for share;
  if not found or not exists (select 1 from public.crm_studio_source_grants where id = binding and expires_at > clock_timestamp())
  then return false; end if;
  return exists (
    select 1 from public.studio_enquiry_transfers t where t.workspace_id = p_workspace and t.operation_id = p_operation
      and t.revision = p_revision and t.payload_hash = p_payload_hash and t.lead_id = p_lead and t.submission_id = p_submission
      and t.source_seq > boundary and t.state = 'accepted' and t.snapshot_text::jsonb->'syntheticTest' = 'false'::jsonb
  );
end
$body$;

revoke all on sequence public.crm_studio_source_seq from public, novalure_app, novalure_tenant_app;
revoke all on function public.crm_studio_source_sequence(), public.crm_studio_source_activate(), public.crm_studio_source_revoke()
  from public, novalure_app, novalure_tenant_app;
revoke all on function public.crm_studio_source_position(text, uuid, text, text, text, text, bigint) from public, novalure_app;
grant execute on function public.crm_studio_source_position(text, uuid, text, text, text, text, bigint) to novalure_tenant_app;
revoke all on function public.crm_studio_source_transfer_matches(uuid,uuid,uuid,uuid,uuid,integer,text,uuid,uuid) from public, novalure_app;
grant execute on function public.crm_studio_source_transfer_matches(uuid,uuid,uuid,uuid,uuid,integer,text,uuid,uuid) to novalure_tenant_app;
