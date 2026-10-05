-- Production-capable CRM machine identity. This extends the existing synthetic
-- contract without granting a database login, Owner authority or BYPASSRLS.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table crm_service_principals
  alter column token_hash drop not null,
  drop constraint crm_service_principals_token_hash_check,
  drop constraint crm_service_principals_tenant_alias_check,
  drop constraint crm_service_principals_agent_id_check,
  drop constraint crm_service_principals_environment_check,
  drop constraint crm_service_principals_synthetic_check;

alter table crm_service_principals
  add column identity_id text,
  add column service_subject text,
  add column consumer text not null default 'EVELYN',
  add column service_role text not null default 'Evelyn.QA',
  add column auth_type text not null default 'STATIC_HASH_QA',
  add column issuer text,
  add column audience text,
  add column secret_reference text,
  add column state text not null default 'ACTIVE',
  add column accepted_key_ids text[] not null default '{}'::text[],
  add column credential_version integer not null default 1,
  add column not_before timestamptz not null default now(),
  add column rotation_overlap_until timestamptz,
  add column last_verified_at timestamptz;

update crm_service_principals
   set identity_id='qa:' || id::text,
       service_subject='qa:' || id::text
 where identity_id is null;

alter table crm_service_principals
  alter column identity_id set not null,
  alter column identity_id set default ('qa:' || gen_random_uuid()::text),
  alter column service_subject set not null,
  alter column service_subject set default ('qa:' || gen_random_uuid()::text),
  add constraint crm_service_principals_identity_id_key unique(identity_id),
  add constraint crm_service_principals_token_hash_check
    check(token_hash is null or token_hash ~ '^[a-f0-9]{64}$'),
  add constraint crm_service_principals_tenant_alias_check
    check(tenant_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$' or tenant_alias ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  add constraint crm_service_principals_agent_id_check
    check(agent_id in ('executive','sales','marketing','buyer','support','finance','engineering','security','legal','qc','procurement','hr','personal','evelyn')),
  add constraint crm_service_principals_environment_check
    check(environment in ('simulation','PRODUCTION')),
  add constraint crm_service_principals_consumer_check check(consumer='EVELYN'),
  add constraint crm_service_principals_role_check check(service_role in ('Evelyn.QA','Evelyn.Service')),
  add constraint crm_service_principals_auth_type_check check(auth_type in ('STATIC_HASH_QA','OIDC_JWKS')),
  add constraint crm_service_principals_state_check check(state in ('ACTIVE','REVOKED','EXPIRED','DISABLED')),
  add constraint crm_service_principals_credential_version_check check(credential_version>0),
  add constraint crm_service_principals_key_ids_check check(cardinality(accepted_key_ids)<=4 and array_position(accepted_key_ids,null) is null),
  add constraint crm_service_principals_auth_model_check check(
    (auth_type='STATIC_HASH_QA' and token_hash is not null and environment='simulation' and synthetic and service_role='Evelyn.QA')
    or
    (auth_type='OIDC_JWKS' and token_hash is null and environment='PRODUCTION' and not synthetic and service_role='Evelyn.Service'
      and issuer is not null and audience is not null and secret_reference is not null and cardinality(accepted_key_ids)>0)
  );

alter table crm_service_resource_bindings
  drop constraint crm_service_resource_bindings_resource_alias_check,
  add constraint crm_service_resource_bindings_resource_alias_check
    check(resource_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$' or resource_alias='EVELYN_INTERNAL_CANARY_SYNTHETIC');

alter table crm_service_audit_bindings
  drop constraint crm_service_audit_bindings_audit_alias_check,
  add constraint crm_service_audit_bindings_audit_alias_check
    check(audit_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$' or audit_alias ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

create table crm_service_kill_switches (
 id uuid primary key default gen_random_uuid(),
 scope text not null check(scope in ('GLOBAL','CRM','TENANT','ACTION')),
 workspace_id uuid references workspaces(id),
 capability text,
 active boolean not null default true,
 reason text not null check(length(trim(reason)) between 1 and 500),
 activated_at timestamptz not null default now(),
 activated_by uuid,
 check(
   (scope in ('GLOBAL','CRM') and workspace_id is null and capability is null)
   or (scope='TENANT' and workspace_id is not null and capability is null)
   or (scope='ACTION' and workspace_id is not null and capability ~ '^crm\.[a-z.]{2,80}$')
 )
);
create unique index crm_service_kill_switch_active_global
  on crm_service_kill_switches(scope) where active and scope in ('GLOBAL','CRM');
create unique index crm_service_kill_switch_active_tenant
  on crm_service_kill_switches(scope,workspace_id) where active and scope='TENANT';
create unique index crm_service_kill_switch_active_action
  on crm_service_kill_switches(scope,workspace_id,capability) where active and scope='ACTION';

create table crm_service_audit_events (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references workspaces(id),
 principal_id uuid not null,
 identity_id text not null,
 actor_user_id uuid not null,
 actor_type text not null check(actor_type='SERVICE_IDENTITY'),
 service_role text not null check(service_role='Evelyn.Service'),
 consumer text not null check(consumer='EVELYN'),
 environment text not null check(environment='PRODUCTION'),
 correlation_id uuid not null,
 action text not null check(action ~ '^crm\.[a-z.]{2,100}$'),
 object_type text not null check(object_type ~ '^[A-Za-z][A-Za-z0-9]{1,63}$'),
 object_id uuid not null,
 jti_hash text not null check(jti_hash ~ '^[a-f0-9]{64}$'),
 outcome text not null check(outcome in ('SUCCESS','DENIED')),
 metadata jsonb not null default '{}'::jsonb,
 occurred_at timestamptz not null default clock_timestamp(),
 foreign key(workspace_id,principal_id) references crm_service_principals(workspace_id,id),
 foreign key(workspace_id,actor_user_id) references workspace_users(workspace_id,id)
);
create index crm_service_audit_workspace_time on crm_service_audit_events(workspace_id,occurred_at desc);
create index crm_service_audit_identity_time on crm_service_audit_events(identity_id,occurred_at desc);

alter table crm_service_kill_switches enable row level security;
alter table crm_service_kill_switches force row level security;
alter table crm_service_audit_events enable row level security;
alter table crm_service_audit_events force row level security;
revoke all on crm_service_kill_switches,crm_service_audit_events from public,novalure_app,novalure_tenant_app;

create trigger crm_service_audit_immutable before update or delete or truncate on crm_service_audit_events
 for each statement execute function crm_reject_immutable_mutation();

create function crm_authenticate_machine(
 p_identity_id text,p_subject text,p_issuer text,p_audience text,p_consumer text,
 p_workspace uuid,p_environment text,p_role text,p_key_id text,p_capabilities text[]
)
returns table(id uuid,workspace_id uuid,actor_user_id uuid,tenant_alias text,agent_id text,scopes text[],data_context text,data_classification text,purpose text,identity_id text,service_subject text,consumer text,service_role text,environment text,auth_type text,issuer text,audience text,secret_reference text,credential_version integer)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_identity_id is null or p_subject is null or p_key_id is null or cardinality(p_capabilities)=0 then return; end if;
 update public.crm_service_principals principal set last_verified_at=clock_timestamp()
  where principal.identity_id=p_identity_id and principal.service_subject=p_subject
    and principal.issuer=p_issuer and principal.audience=p_audience and principal.consumer=p_consumer
    and principal.workspace_id=p_workspace and principal.tenant_alias=p_workspace::text
    and principal.environment=p_environment and principal.service_role=p_role
    and principal.auth_type='OIDC_JWKS' and not principal.synthetic
    and principal.state='ACTIVE' and principal.revoked_at is null
    and principal.not_before<=clock_timestamp() and principal.expires_at>clock_timestamp()
    and p_key_id=any(principal.accepted_key_ids)
    and p_capabilities <@ principal.scopes;
 return query
 select principal.id,principal.workspace_id,principal.actor_user_id,principal.tenant_alias,principal.agent_id,principal.scopes,
        principal.data_context,principal.data_classification,principal.purpose,principal.identity_id,principal.service_subject,
        principal.consumer,principal.service_role,principal.environment,principal.auth_type,principal.issuer,principal.audience,
        principal.secret_reference,principal.credential_version
   from public.crm_service_principals principal
   join public.workspace_users member on member.id=principal.actor_user_id and member.workspace_id=principal.workspace_id
   join public.workspaces workspace on workspace.id=principal.workspace_id
  where principal.identity_id=p_identity_id and principal.service_subject=p_subject
    and principal.issuer=p_issuer and principal.audience=p_audience and principal.consumer=p_consumer
    and principal.workspace_id=p_workspace and principal.tenant_alias=p_workspace::text
    and principal.environment=p_environment and principal.service_role=p_role
    and principal.auth_type='OIDC_JWKS' and not principal.synthetic
    and principal.state='ACTIVE' and principal.revoked_at is null
    and principal.not_before<=clock_timestamp() and principal.expires_at>clock_timestamp()
    and p_key_id=any(principal.accepted_key_ids) and p_capabilities <@ principal.scopes
    and member.status='active' and member.role='agent' and member.product_role='project_sales_member'
    and workspace.operating_model in ('self_service_customer','managed_by_novalure','hybrid')
    and not exists(
      select 1 from public.crm_service_kill_switches stop
       where stop.active and (stop.scope in ('GLOBAL','CRM') or (stop.scope='TENANT' and stop.workspace_id=p_workspace))
    )
  for share of principal,member,workspace;
end $$;
revoke all on function crm_authenticate_machine(text,text,text,text,text,uuid,text,text,text,text[]) from public;
grant execute on function crm_authenticate_machine(text,text,text,text,text,uuid,text,text,text,text[]) to novalure_tenant_app;

create function crm_service_action_allowed(p_principal uuid,p_capability text)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(
   select 1 from public.crm_service_principals principal
    where principal.id=p_principal and principal.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
      and principal.actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid
      and principal.state='ACTIVE' and principal.revoked_at is null and principal.expires_at>clock_timestamp()
      and principal.auth_type='OIDC_JWKS' and principal.environment='PRODUCTION' and principal.service_role='Evelyn.Service'
      and p_capability=any(principal.scopes)
      and not exists(
        select 1 from public.crm_service_kill_switches stop where stop.active and (
          stop.scope in ('GLOBAL','CRM')
          or (stop.scope='TENANT' and stop.workspace_id=principal.workspace_id)
          or (stop.scope='ACTION' and stop.workspace_id=principal.workspace_id and stop.capability=p_capability)
        )
      )
 )
$$;
revoke all on function crm_service_action_allowed(uuid,text) from public;
grant execute on function crm_service_action_allowed(uuid,text) to novalure_tenant_app;

create function crm_record_service_audit(
 p_principal uuid,p_correlation uuid,p_action text,p_object_type text,p_object_id uuid,p_jti_hash text,p_outcome text,p_metadata jsonb
)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare principal public.crm_service_principals%rowtype; audit_id uuid:=gen_random_uuid();
begin
 select * into principal from public.crm_service_principals candidate
  where candidate.id=p_principal
    and candidate.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and candidate.actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid
    and candidate.auth_type='OIDC_JWKS' and candidate.environment='PRODUCTION'
    and candidate.service_role='Evelyn.Service' and candidate.consumer='EVELYN'
    and candidate.state='ACTIVE' and candidate.revoked_at is null and candidate.expires_at>clock_timestamp()
  for share;
 if not found then raise exception using errcode='42501',message='SERVICE_IDENTITY_DENIED'; end if;
 insert into public.crm_service_audit_events(id,workspace_id,principal_id,identity_id,actor_user_id,actor_type,service_role,consumer,environment,correlation_id,action,object_type,object_id,jti_hash,outcome,metadata)
 values(audit_id,principal.workspace_id,principal.id,principal.identity_id,principal.actor_user_id,'SERVICE_IDENTITY',principal.service_role,principal.consumer,principal.environment,p_correlation,p_action,p_object_type,p_object_id,p_jti_hash,p_outcome,coalesce(p_metadata,'{}'::jsonb));
 return audit_id;
end $$;
revoke all on function crm_record_service_audit(uuid,uuid,text,text,uuid,text,text,jsonb) from public;
grant execute on function crm_record_service_audit(uuid,uuid,text,text,uuid,text,text,jsonb) to novalure_tenant_app;
