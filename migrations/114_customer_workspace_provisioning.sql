-- A regular, authenticated CRM entry point for isolated customer test workspaces.
-- Installs no customer, identity, password, channel, domain, billing or knowledge data.
set local lock_timeout = '5s';
set local statement_timeout = '5min';

do $guard$
begin
  if to_regclass('public.knowledge_center_entitlements') is null
    or to_regprocedure('public.knowledge_connected_assistant_count(uuid,uuid)') is null
    or to_regclass('public.crm_command_receipts') is null
    or not exists(select 1 from pg_attribute where attrelid='public.knowledge_center_entitlements'::regclass and attname='monitoring_intervals' and not attisdropped)
    or not exists(select 1 from pg_constraint where conrelid='public.workspaces'::regclass
      and conname='workspaces_customer_type_check' and pg_get_constraintdef(oid) like '%general_company%') then
    raise exception using errcode='55000',message='Customer provisioning requires the Knowledge quota and CRM command predecessors';
  end if;
  if not exists(select 1 from pg_roles where rolname='novalure_customer_provisioner') then
    create role novalure_customer_provisioner nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists(select 1 from pg_roles where rolname='novalure_customer_provisioner'
    and (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication))
    or pg_has_role('novalure_tenant_app','novalure_customer_provisioner','MEMBER')
    or pg_has_role('novalure_app','novalure_customer_provisioner','MEMBER') then
    raise exception using errcode='42501',message='Unsafe customer provisioning role';
  end if;
  execute format('grant novalure_customer_provisioner to %I',current_user);
end
$guard$;

-- The function owner uses the same forced RLS policies as the app for customer
-- rows. Only this NOLOGIN owner may bootstrap a new workspace and its test limit.
grant novalure_tenant_app to novalure_customer_provisioner;
grant usage,create on schema public to novalure_customer_provisioner;
grant select,insert on public.workspaces,public.workspace_users,public.workspace_module_settings to novalure_customer_provisioner;
grant insert on public.knowledge_center_entitlements to novalure_customer_provisioner;
-- SELECT ... FOR SHARE needs one UPDATE privilege; these grants expose no
-- credential, role, session-revocation or MFA mutation to the function owner.
grant update(updated_at) on public.workspace_users to novalure_customer_provisioner;
grant update(last_seen_at) on public.auth_sessions to novalure_customer_provisioner;
grant select(id,normalized_email,display_email,credential_state,disabled_at) on public.auth_identities to novalure_customer_provisioner;
-- Required by the existing membership identity trigger. The function uses only
-- the locked existing identity's email and never supplies password_hash.
grant insert(normalized_email,display_email,password_hash,credential_state,password_changed_at)
  on public.auth_identities to novalure_customer_provisioner;
grant update(display_email,updated_at) on public.auth_identities to novalure_customer_provisioner;

create function public.crm_customer_provisioning_authorized(p_auth_session uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $function$
begin
  perform s.id from public.auth_sessions s
    join public.workspace_users u on u.id=s.workspace_user_id and u.workspace_id=s.workspace_id and u.auth_identity_id=s.auth_identity_id
    join public.auth_identities identity on identity.id=u.auth_identity_id
    where s.id=p_auth_session
      and u.workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid
      and u.id=nullif(current_setting('app.actor_id',true),'')::uuid
      and u.status='active' and u.role in ('owner','admin')
      and u.product_role in ('platform_admin','novalureAdmin','novalure_onboarding')
      and identity.credential_state='active' and identity.disabled_at is null
      and identity.normalized_email=lower(btrim(u.email))
      and s.revoked_at is null and s.expires_at>now() and s.mfa_verified_at is not null
    -- The membership trigger updates this same identity's display metadata.
    -- Lock it for update now so concurrent setup/retry calls cannot deadlock
    -- while upgrading two shared identity locks after command serialization.
    for share of s,u for update of identity;
  return found;
end
$function$;

create function public.crm_provision_customer_workspace(p_auth_session uuid,p_request_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $function$
declare
  origin_workspace text:=current_setting('app.tenant_id',true);
  origin_actor text:=current_setting('app.actor_id',true);
  actor_name text; actor_email text; actor_identity uuid; target_identity uuid;
  workspace_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); project_id uuid:=gen_random_uuid();
  bot_id uuid:=gen_random_uuid(); area_id uuid:=gen_random_uuid();
  workspace_slug text; project_type text; setup jsonb; modules jsonb;
  customer_type text; customer_name text; project_name text; bot_name text; website_url text;
  limits jsonb:='{"maxAssistants":1,"maxSources":20,"maxStorageBytes":10485760,"maxQueriesPerMonth":100,"maxScansPerMonth":10,"maxAreas":5,"maxWebsites":10,"maxUsers":2}'::jsonb;
begin
  if not public.crm_customer_provisioning_authorized(p_auth_session) then
    raise exception using errcode='42501',message='An active internal administrator MFA session is required';
  end if;
  if p_request_id is null or p_request_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or p_payload-array['name','projectName','botName','websiteUrl','customerType'] <> '{}'::jsonb
    or not (p_payload ?& array['name','projectName','botName','websiteUrl','customerType']) then
    raise exception using errcode='23514',message='Invalid customer provisioning request';
  end if;
  customer_name:=btrim(p_payload->>'name'); project_name:=btrim(p_payload->>'projectName');
  bot_name:=btrim(p_payload->>'botName'); website_url:=p_payload->>'websiteUrl'; customer_type:=p_payload->>'customerType';
  if jsonb_typeof(p_payload->'name')<>'string' or jsonb_typeof(p_payload->'projectName')<>'string'
    or jsonb_typeof(p_payload->'botName')<>'string' or jsonb_typeof(p_payload->'websiteUrl')<>'string'
    or jsonb_typeof(p_payload->'customerType')<>'string'
    or length(customer_name) not between 1 and 160 or length(project_name) not between 1 and 160 or length(bot_name) not between 1 and 160
    or customer_name ~ '[[:cntrl:]]' or project_name ~ '[[:cntrl:]]' or bot_name ~ '[[:cntrl:]]'
    or length(website_url)>2048 or website_url !~ '^https://[^/@[:space:]]+[.][^/@[:space:]]+(/|$)'
    or customer_type not in ('real_estate_broker','property_developer','hybrid_real_estate','general_company') then
    raise exception using errcode='23514',message='Invalid customer provisioning fields';
  end if;
  select u.name,u.email,u.auth_identity_id into strict actor_name,actor_email,actor_identity
    from public.workspace_users u where u.id=origin_actor::uuid and u.workspace_id=origin_workspace::uuid;
  workspace_slug:='customer-'||p_request_id::text;
  project_type:=case customer_type when 'property_developer' then 'Bauträger' when 'real_estate_broker' then 'Makler'
    when 'hybrid_real_estate' then 'Immobilien' else 'Unternehmen' end;
  modules:='{"dashboard":true,"leadInbox":true,"contacts":true,"pipeline":false,"deals":false,"tasks":false,"calendar":false,"communication":true,"funnels":false,"newsletter":false,"bots":true,"knowledge":true,"analytics":false,"settings":true,"objectsMandates":false,"units":false,"reservations":false,"projectOverview":true}'::jsonb;
  setup:=jsonb_build_object('setupKind','customer_chatbot_trial','websiteUrl',website_url,'enabledModules',modules,'defaultProjectId',project_id);

  insert into public.workspaces(id,name,slug,plan,operating_model,customer_type,team_structure,active_calendar_provider,setup_state)
    values(workspace_id,customer_name,workspace_slug,'Betreuter Testmandant','managed_by_novalure',customer_type,'no_sales_team','none',setup);
  insert into public.workspace_users(id,workspace_id,name,email,role,product_role,status,auth_identity_id)
    values(member_id,workspace_id,actor_name,actor_email,'admin','workspace_admin','active',actor_identity)
    returning auth_identity_id into target_identity;
  if target_identity is distinct from actor_identity then
    raise exception using errcode='42501',message='Customer membership must retain the authenticated identity';
  end if;

  -- Context is derived only from the newly inserted membership, never request IDs.
  perform set_config('app.tenant_id',workspace_id::text,true),set_config('app.actor_id',member_id::text,true);
  insert into public.projects(id,workspace_id,name,type,status,customer_type,default_operating_model,data_classification)
    values(project_id,workspace_id,project_name,project_type,'Aktiv',customer_type,'managed_by_novalure','CUSTOMER_TENANT');
  insert into public.bots(id,workspace_id,project_id,name,role,status,model,strict_knowledge,description,language,tone,config,data_classification)
    values(bot_id,workspace_id,project_id,bot_name,'sales_qualifier','draft','openai/gpt-5.4',true,
      'Beantwortet Fragen auf Grundlage des veröffentlichten Kundenwissens.','de','Natürlich und freundlich',
      '{"channels":[],"tools":[],"actionPolicies":[],"setupChecklist":[],"documentLibrary":[]}'::jsonb,'CUSTOMER_TENANT');
  insert into public.knowledge_areas(id,workspace_id,name,kind,project_id)
    values(area_id,workspace_id,project_name,'project',project_id);
  insert into public.knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,features,limits,contract_reference,monitoring_intervals)
    values(workspace_id,true,20,10485760,100,
      '{"websiteImport":true,"webchatAccess":true,"voiceAccess":false,"monitoring":false,"advancedMaintenance":false}'::jsonb,
      limits-'maxSources'-'maxStorageBytes'-'maxQueriesPerMonth','internal-customer-trial:'||p_request_id::text,array['manual']::text[]);
  insert into public.workspace_module_settings(workspace_id,module_key,enabled,reason)
    select workspace_id,key,value::boolean,'Kunden-Chatbot-Testeinrichtung' from jsonb_each_text(modules);
  insert into public.audit_logs(workspace_id,actor_user_id,project_id,action,entity_type,entity_id,after)
    values(workspace_id,member_id,project_id,'customer.workspace.provisioned','workspace',workspace_id,
      jsonb_build_object('requestId',p_request_id,'projectId',project_id,'botId',bot_id,'knowledgeAreaId',area_id,
        'membershipRole','workspace_admin','dataClassification','CUSTOMER_TENANT','limits',limits,'websiteUrl',website_url));

  perform set_config('app.tenant_id',origin_workspace,true),set_config('app.actor_id',origin_actor,true);
  return jsonb_build_object(
    'workspace',jsonb_build_object('id',workspace_id,'name',customer_name,'slug',workspace_slug,'plan','Betreuter Testmandant',
      'customerType',customer_type,'operatingModel','managed_by_novalure','role','admin','productRole','workspace_admin',
      'teamStructure','no_sales_team','activeCalendarProvider','none','setupState',setup),
    'project',jsonb_build_object('id',project_id,'name',project_name,'workspaceId',workspace_id,'type',project_type,'status','Aktiv','customerType',customer_type),
    'bot',jsonb_build_object('id',bot_id,'name',bot_name,'workspaceId',workspace_id,'projectId',project_id,'status','draft'),
    'knowledgeArea',jsonb_build_object('id',area_id,'name',project_name,'workspaceId',workspace_id,'projectId',project_id,'kind','project'),
    'limits',limits);
exception when others then
  perform set_config('app.tenant_id',coalesce(origin_workspace,''),true),set_config('app.actor_id',coalesce(origin_actor,''),true);
  raise;
end
$function$;

alter function public.crm_customer_provisioning_authorized(uuid) owner to novalure_customer_provisioner;
alter function public.crm_provision_customer_workspace(uuid,uuid,jsonb) owner to novalure_customer_provisioner;
revoke create on schema public from novalure_customer_provisioner;
revoke all on function public.crm_customer_provisioning_authorized(uuid),public.crm_provision_customer_workspace(uuid,uuid,jsonb) from public;
grant execute on function public.crm_customer_provisioning_authorized(uuid),public.crm_provision_customer_workspace(uuid,uuid,jsonb) to novalure_tenant_app;
