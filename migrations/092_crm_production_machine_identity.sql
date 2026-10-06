-- CRM-U1-C07: exact Evelyn Production workload identity on the accepted forced-RLS line.
-- No new relation is created: the forced-RLS inventory remains 68/68.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

alter table public.crm_service_principals
  alter column token_hash drop not null,
  drop constraint if exists crm_service_principals_token_hash_check,
  drop constraint if exists crm_service_principals_tenant_alias_check,
  drop constraint if exists crm_service_principals_agent_id_check,
  drop constraint if exists crm_service_principals_environment_check,
  drop constraint if exists crm_service_principals_synthetic_check;

alter table public.crm_service_principals
  add column if not exists identity_id text,
  add column if not exists service_subject text,
  add column if not exists consumer text not null default 'EVELYN',
  add column if not exists service_role text not null default 'Evelyn.QA',
  add column if not exists auth_type text not null default 'STATIC_HASH_QA',
  add column if not exists issuer text,
  add column if not exists audience text,
  add column if not exists oidc_project_id text,
  add column if not exists oidc_owner_id text,
  add column if not exists state text not null default 'ACTIVE',
  add column if not exists not_before timestamptz not null default now(),
  add column if not exists kill_switch_active boolean not null default false,
  add column if not exists kill_switch_reason text,
  add column if not exists last_verified_at timestamptz;

update public.crm_service_principals
set identity_id = coalesce(identity_id, 'qa:' || id::text),
    service_subject = coalesce(service_subject, 'qa:' || id::text)
where identity_id is null or service_subject is null;

alter table public.crm_service_principals
  alter column identity_id set not null,
  alter column service_subject set not null,
  add constraint crm_service_principals_identity_id_key unique(identity_id),
  add constraint crm_service_principals_token_hash_check check(token_hash is null or token_hash ~ '^[a-f0-9]{64}$'),
  add constraint crm_service_principals_tenant_alias_check check(tenant_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$' or tenant_alias ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  add constraint crm_service_principals_agent_id_check check(agent_id in ('executive','sales','marketing','buyer','support','finance','engineering','security','legal','qc','procurement','hr','personal','evelyn')),
  add constraint crm_service_principals_environment_check check(environment in ('simulation','production')),
  add constraint crm_service_principals_synthetic_check check(synthetic),
  add constraint crm_service_principals_consumer_check check(consumer = 'EVELYN'),
  add constraint crm_service_principals_role_check check(service_role in ('Evelyn.QA','Evelyn.Service')),
  add constraint crm_service_principals_auth_type_check check(auth_type in ('STATIC_HASH_QA','VERCEL_OIDC')),
  add constraint crm_service_principals_state_check check(state in ('ACTIVE','REVOKED','EXPIRED','DISABLED')),
  add constraint crm_service_principals_kill_reason_check check(not kill_switch_active or nullif(trim(kill_switch_reason),'') is not null),
  add constraint crm_service_principals_auth_model_check check(
    (auth_type = 'STATIC_HASH_QA' and token_hash is not null and environment = 'simulation' and service_role = 'Evelyn.QA')
    or
    (auth_type = 'VERCEL_OIDC' and token_hash is null and environment = 'production' and service_role = 'Evelyn.Service'
      and issuer is not null and audience is not null and oidc_project_id is not null and oidc_owner_id is not null)
  );

alter table public.crm_service_resource_bindings
  drop constraint if exists crm_service_resource_bindings_resource_alias_check,
  add constraint crm_service_resource_bindings_resource_alias_check check(resource_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$' or resource_alias = 'EVELYN_INTERNAL_CANARY_SYNTHETIC');

alter table public.crm_service_audit_bindings
  drop constraint if exists crm_service_audit_bindings_audit_alias_check,
  add constraint crm_service_audit_bindings_audit_alias_check check(audit_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$' or audit_alias ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  add column if not exists jti_hash text,
  add column if not exists correlation_id uuid,
  add column if not exists action text,
  add column if not exists object_type text,
  add column if not exists object_id uuid,
  add column if not exists outcome text,
  add constraint crm_service_audit_jti_hash_check check(jti_hash is null or jti_hash ~ '^[a-f0-9]{64}$'),
  add constraint crm_service_audit_action_check check(action is null or action ~ '^crm\.[a-z.]{2,100}$'),
  add constraint crm_service_audit_object_type_check check(object_type is null or object_type ~ '^[A-Za-z][A-Za-z0-9]{1,63}$'),
  add constraint crm_service_audit_outcome_check check(outcome is null or outcome = 'SUCCESS');

create unique index crm_service_audit_machine_jti_uidx on public.crm_service_audit_bindings(principal_id, jti_hash) where jti_hash is not null;

create or replace function public.crm_authenticate_machine(p_identity_id text,p_subject text,p_issuer text,p_audience text,p_project_id text,p_owner_id text,p_workspace uuid,p_environment text,p_role text)
returns table(id uuid,workspace_id uuid,actor_user_id uuid,tenant_alias text,agent_id text,scopes text[],data_context text,data_classification text,purpose text,identity_id text,service_subject text,consumer text,service_role text,environment text,auth_type text,issuer text,audience text)
language sql stable security definer set search_path = pg_catalog, public as $function$
  select principal.id,principal.workspace_id,principal.actor_user_id,principal.tenant_alias,principal.agent_id,principal.scopes,principal.data_context,principal.data_classification,principal.purpose,principal.identity_id,principal.service_subject,principal.consumer,principal.service_role,principal.environment,principal.auth_type,principal.issuer,principal.audience
  from public.crm_service_principals principal
  join public.workspace_users member on member.id=principal.actor_user_id and member.workspace_id=principal.workspace_id
  join public.workspaces workspace on workspace.id=principal.workspace_id
  where principal.identity_id=p_identity_id and principal.service_subject=p_subject and principal.issuer=p_issuer and principal.audience=p_audience
    and principal.oidc_project_id=p_project_id and principal.oidc_owner_id=p_owner_id and principal.consumer='EVELYN'
    and principal.workspace_id=p_workspace and principal.tenant_alias=p_workspace::text and principal.environment=p_environment and principal.service_role=p_role
    and principal.agent_id='evelyn' and principal.auth_type='VERCEL_OIDC' and principal.synthetic and principal.state='ACTIVE'
    and not principal.kill_switch_active and principal.revoked_at is null and principal.not_before<=clock_timestamp() and principal.expires_at>clock_timestamp()
    and member.status='active' and member.role='agent' and member.product_role='project_sales_member'
    and workspace.operating_model in ('self_service_customer','managed_by_novalure','hybrid')
$function$;
revoke all on function public.crm_authenticate_machine(text,text,text,text,text,text,uuid,text,text) from public,novalure_app;
grant execute on function public.crm_authenticate_machine(text,text,text,text,text,text,uuid,text,text) to novalure_tenant_app;

create or replace function public.crm_machine_action_allowed(p_principal uuid,p_capability text)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $function$
  select exists(select 1 from public.crm_service_principals principal
    where principal.id=p_principal and principal.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
      and principal.actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid and principal.auth_type='VERCEL_OIDC'
      and principal.environment='production' and principal.service_role='Evelyn.Service' and principal.consumer='EVELYN'
      and principal.state='ACTIVE' and not principal.kill_switch_active and principal.revoked_at is null
      and principal.not_before<=clock_timestamp() and principal.expires_at>clock_timestamp() and p_capability=any(principal.scopes))
$function$;
revoke all on function public.crm_machine_action_allowed(uuid,text) from public,novalure_app;
grant execute on function public.crm_machine_action_allowed(uuid,text) to novalure_tenant_app;

create or replace function public.crm_claim_machine_request(p_principal uuid,p_resource_alias text,p_audit uuid,p_request_hash text,p_jti_hash text,p_correlation uuid,p_action text,p_object_type text,p_object_id uuid,p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $function$
declare claimed text;
begin
  if p_request_hash !~ '^[a-f0-9]{64}$' or p_jti_hash !~ '^[a-f0-9]{64}$' or p_action !~ '^crm\.[a-z.]{2,100}$'
     or p_object_type !~ '^[A-Za-z][A-Za-z0-9]{1,63}$' or p_expires_at<=clock_timestamp()
     or p_expires_at>clock_timestamp()+interval '12 hours 1 minute' or not public.crm_machine_action_allowed(p_principal,p_action) then return false; end if;
  insert into public.crm_service_audit_bindings(principal_id,workspace_id,audit_alias,resource_alias,request_hash,expires_at,jti_hash,correlation_id,action,object_type,object_id,outcome)
  select principal.id,principal.workspace_id,p_audit::text,p_resource_alias,p_request_hash,p_expires_at,p_jti_hash,p_correlation,p_action,p_object_type,p_object_id,'SUCCESS'
  from public.crm_service_principals principal
  where principal.id=p_principal and principal.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    and principal.actor_user_id=nullif(current_setting('app.actor_id',true),'')::uuid
    and exists(select 1 from public.crm_service_resource_bindings binding where binding.principal_id=principal.id and binding.workspace_id=principal.workspace_id and binding.resource_alias=p_resource_alias and binding.source_id=p_object_id)
  on conflict (principal_id,jti_hash) where jti_hash is not null do nothing returning audit_alias into claimed;
  return claimed is not null;
end $function$;
revoke all on function public.crm_claim_machine_request(uuid,text,uuid,text,text,uuid,text,text,uuid,timestamptz) from public,novalure_app;
grant execute on function public.crm_claim_machine_request(uuid,text,uuid,text,text,uuid,text,text,uuid,timestamptz) to novalure_tenant_app;

-- One exact synthetic workload binding. No customer record and no reusable
-- credential is created; Vercel signs every short-lived request token.
insert into public.workspace_users(id,workspace_id,name,email,role,product_role,status)
values(
  '6122a6da-e7f4-47fa-bc55-e296bb01af62',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'SYNTHETIC: Evelyn CRM service actor',
  'evelyn-crm-service@service.invalid',
  'agent',
  'project_sales_member',
  'active'
);

insert into public.projects(id,workspace_id,name,type,status,data_classification,data_purpose)
values(
  'f1f039d0-b2a5-4c60-8d2c-97be0dcddedd',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'SYNTHETIC: Evelyn CRM machine proof',
  'SYNTHETIC: Internal',
  'Aktiv',
  'CUSTOMER_TENANT',
  'crm_sales'
);

insert into public.project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals)
values(
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'f1f039d0-b2a5-4c60-8d2c-97be0dcddedd',
  '6122a6da-e7f4-47fa-bc55-e296bb01af62',
  true,
  true
);

insert into public.tasks(id,workspace_id,project_id,title,priority,status,version,data_classification,data_purpose)
values(
  '2fdefb1e-8690-4a84-bf44-485d9858bab4',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'f1f039d0-b2a5-4c60-8d2c-97be0dcddedd',
  'SYNTHETIC: Evelyn workload proof',
  'Normal',
  'open',
  1,
  'CUSTOMER_TENANT',
  'crm_sales'
);

insert into public.crm_service_principals(
  id,workspace_id,actor_user_id,token_hash,tenant_alias,agent_id,scopes,
  data_context,data_classification,purpose,environment,synthetic,expires_at,
  identity_id,service_subject,consumer,service_role,auth_type,issuer,audience,
  oidc_project_id,oidc_owner_id,state,not_before
)
values(
  '8b3238e9-efea-459f-ac84-a08e2a6ec59b',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  '6122a6da-e7f4-47fa-bc55-e296bb01af62',
  null,
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'evelyn',
  array['crm.tasks.read','crm.tasks.write']::text[],
  'CUSTOMER_TENANT',
  'CONFIDENTIAL',
  'OPERATIONS',
  'production',
  true,
  '2027-10-06T00:00:00Z',
  'EVELYN_CRM_SERVICE_IDENTITY',
  'owner:novalure:project:evelyn:environment:production',
  'EVELYN',
  'Evelyn.Service',
  'VERCEL_OIDC',
  'https://oidc.vercel.com/novalure',
  'urn:novalure:crm:production',
  'prj_8bbjKnQ5XDr52YYPRYtvqtoSj71I',
  'team_sjD78IkSicXJK6TAOR1JC7Wv',
  'ACTIVE',
  clock_timestamp()-interval '1 minute'
);

insert into public.crm_service_resource_bindings(
  principal_id,workspace_id,resource_alias,entity,source_id,project_id,
  data_context,data_classification,domain,purpose
)
values(
  '8b3238e9-efea-459f-ac84-a08e2a6ec59b',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'EVELYN_INTERNAL_CANARY_SYNTHETIC',
  'Task',
  '2fdefb1e-8690-4a84-bf44-485d9858bab4',
  'f1f039d0-b2a5-4c60-8d2c-97be0dcddedd',
  'CUSTOMER_TENANT',
  'CONFIDENTIAL',
  'BUSINESS',
  'OPERATIONS'
);

do $verify$ declare relation_count integer; forced_count integer; binding_count integer; begin
  select count(*),count(*) filter(where c.relforcerowsecurity) into relation_count,forced_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity;
  if relation_count<>68 or forced_count<>68 then raise exception using errcode='55000',message=format('092 requires and preserves exact forced RLS inventory 68/68, observed %s/%s',forced_count,relation_count); end if;
  select count(*) into binding_count
  from public.crm_service_principals principal
  join public.crm_service_resource_bindings binding on binding.principal_id=principal.id and binding.workspace_id=principal.workspace_id
  where principal.id='8b3238e9-efea-459f-ac84-a08e2a6ec59b'
    and principal.identity_id='EVELYN_CRM_SERVICE_IDENTITY'
    and principal.workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
    and binding.resource_alias='EVELYN_INTERNAL_CANARY_SYNTHETIC'
    and binding.source_id='2fdefb1e-8690-4a84-bf44-485d9858bab4';
  if binding_count<>1 then raise exception using errcode='55000',message='092 exact Evelyn machine binding verification failed'; end if;
end $verify$;
