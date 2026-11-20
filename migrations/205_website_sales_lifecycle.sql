-- Sales lifecycle evidence only. No outbound, contract, invoice or provider activation.
set local lock_timeout='5s';
set local statement_timeout='14min';
create table crm_website_sales_refreshes (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 old_observation_id uuid not null,new_observation_id uuid not null,evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 created_by uuid not null,created_at timestamptz not null default now(),unique(workspace_id,id),unique(workspace_id,project_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,old_observation_id) references crm_website_sales_observations(workspace_id,id),
 foreign key(workspace_id,new_observation_id) references crm_website_sales_observations(workspace_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_offer_invalidations (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,refresh_id uuid not null,
 offer_id uuid not null,revision integer not null check(revision>0),content_digest text not null check(content_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),unique(workspace_id,offer_id,revision),
 foreign key(workspace_id,project_id,refresh_id) references crm_website_sales_refreshes(workspace_id,project_id,id),
 foreign key(workspace_id,offer_id) references crm_offers(workspace_id,id)
);
create table crm_website_sales_reply_permissions (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 source_user_id uuid not null,message_id uuid not null,authorized_by uuid not null,
 purpose text not null check(purpose='BOUNDED_CLASSIFICATION_ONLY'),version integer not null check(version>0),
 created_at timestamptz not null default now(),expires_at timestamptz not null check(expires_at>created_at and expires_at<=created_at+interval '24 hours'),
 unique(workspace_id,id),unique(workspace_id,workflow_id,message_id,version),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,source_user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id),
 foreign key(workspace_id,authorized_by) references workspace_users(workspace_id,id),check(source_user_id=authorized_by)
);
create table crm_website_sales_reply_revocations (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,permission_id uuid not null,revoked_by uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,permission_id),foreign key(workspace_id,permission_id) references crm_website_sales_reply_permissions(workspace_id,id),
 foreign key(workspace_id,revoked_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_inbound_events (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 source_user_id uuid not null,message_id uuid not null,source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 classification text not null check(classification in('INTERESTED','QUESTION','OUT_OF_OFFICE','UNCLEAR','OPT_OUT')),
 classification_basis text not null default 'BOUNDED_SOURCE_RULES_REVIEW_REQUIRED' check(classification_basis='BOUNDED_SOURCE_RULES_REVIEW_REQUIRED'),
 received_at timestamptz not null,late boolean not null default false,next_task_id uuid,created_by uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,workflow_id,message_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,source_user_id,message_id) references crm_mailbox_messages(workspace_id,user_id,id),
 foreign key(workspace_id,next_task_id) references tasks(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_customer_acceptances (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 concept_artifact_id uuid not null,demo_artifact_id uuid not null,concept_digest text not null,demo_digest text not null,evidence_digest text not null,
 source_reference text not null check(length(trim(source_reference)) between 5 and 2000),
 acceptance_digest text not null check(acceptance_digest ~ '^[a-f0-9]{64}$'),
 scope jsonb not null check(jsonb_typeof(scope)='object' and octet_length(scope::text)<=16000),
 attestation_kind text not null default 'OPERATOR_RECORDED_CUSTOMER_ACCEPTANCE' check(attestation_kind='OPERATOR_RECORDED_CUSTOMER_ACCEPTANCE'),
 accepted_by uuid not null,created_at timestamptz not null default now(),unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),unique(workspace_id,workflow_id,acceptance_digest),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,concept_artifact_id) references crm_website_studio_artifacts(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,demo_artifact_id) references crm_website_studio_artifacts(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,accepted_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_handoffs (
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 customer_acceptance_id uuid not null,task_id uuid not null,snapshot jsonb not null check(jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=24000),
 snapshot_digest text not null check(snapshot_digest ~ '^[a-f0-9]{64}$'),created_by uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,customer_acceptance_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,customer_acceptance_id) references crm_website_sales_customer_acceptances(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,task_id) references tasks(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
do $$ declare relation text;begin
 foreach relation in array array['crm_website_sales_refreshes','crm_website_sales_offer_invalidations','crm_website_sales_reply_permissions','crm_website_sales_reply_revocations',
   'crm_website_sales_inbound_events','crm_website_sales_customer_acceptances','crm_website_sales_handoffs'] loop
  execute format('alter table %I add column data_classification text not null default ''UNCLASSIFIED'',add column data_purpose text not null default ''crm_sales''',relation);
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
  execute format('alter table %I enable row level security',relation);execute format('alter table %I force row level security',relation);
  execute format('create policy website_sales_lifecycle_scope on %I for all to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
  execute format('revoke all on %I from public',relation);execute format('grant select,insert on %I to novalure_tenant_app',relation);
  execute format('create trigger website_sales_lifecycle_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);
 end loop;
end $$;

-- The non-runtime function owner receives a context-limited read policy only.
-- Runtime personal-mail policies and column privileges remain unchanged.
do $$ declare relation text;begin
 foreach relation in array array['crm_website_sales_workflows','contacts','crm_website_sales_reply_permissions','crm_website_sales_reply_revocations'] loop
  execute format('create policy sales_inbound_projection_owner on %I for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_project_access(workspace_id,project_id,false))',relation,current_user);
 end loop;
 execute format('create policy sales_inbound_link_owner on crm_mailbox_links for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and confirmed_reply and crm_project_access(workspace_id,project_id,false))',current_user);
 execute format('create policy sales_inbound_message_owner on crm_mailbox_messages for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and exists(select 1 from crm_mailbox_links l where l.workspace_id=crm_mailbox_messages.workspace_id and l.user_id=crm_mailbox_messages.user_id and l.message_id=crm_mailbox_messages.id and l.confirmed_reply and crm_project_access(l.workspace_id,l.project_id,false)))',current_user);
end $$;

-- Minimal classification of an already personally reviewed canonical message.
-- No generic mail/conversation SELECT privilege or raw content is returned.
create function crm_website_sales_inbound_source(p_workspace uuid,p_project uuid,p_workflow uuid,p_message uuid default null)
returns table(message_id uuid,source_user_id uuid,received_at timestamptz,source_hash text,classification text,body_shared boolean,can_authorize boolean)
language plpgsql security definer set search_path=pg_catalog,public,pg_temp set row_security=on as $$
declare target public.crm_website_sales_workflows%rowtype;
begin
 if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
   or not crm_lock_project_access(p_workspace,p_project,false)
   or not crm_classification_allowed(p_workspace,'NOVALURE_INTERNAL','crm_sales') then
   raise exception using errcode='42501',message='Sales reply scope denied';end if;
 select * into target from public.crm_website_sales_workflows where workspace_id=p_workspace and project_id=p_project and id=p_workflow;
 if not found or target.contact_id is null then return;end if;
 return query
 with sources as (
  select m.id,m.user_id,m.received_at,m.revision,
   exists(select 1 from public.crm_website_sales_reply_permissions consent
    where consent.workspace_id=p_workspace and consent.workflow_id=target.id and consent.message_id=m.id and consent.source_user_id=m.user_id
      and consent.expires_at>clock_timestamp() and not exists(select 1 from public.crm_website_sales_reply_permissions newer where newer.workspace_id=consent.workspace_id and newer.workflow_id=consent.workflow_id and newer.message_id=consent.message_id and newer.version>consent.version)
      and not exists(select 1 from public.crm_website_sales_reply_revocations revoked where revoked.workspace_id=consent.workspace_id and revoked.permission_id=consent.id)) as shared,
   case when m.body_truncated or not exists(select 1 from public.crm_website_sales_reply_permissions consent
    where consent.workspace_id=p_workspace and consent.workflow_id=target.id and consent.message_id=m.id and consent.source_user_id=m.user_id
      and consent.expires_at>clock_timestamp() and not exists(select 1 from public.crm_website_sales_reply_permissions newer where newer.workspace_id=consent.workspace_id and newer.workflow_id=consent.workflow_id and newer.message_id=consent.message_id and newer.version>consent.version)
      and not exists(select 1 from public.crm_website_sales_reply_revocations revoked where revoked.workspace_id=consent.workspace_id and revoked.permission_id=consent.id)) then ''
    else left(regexp_replace(regexp_replace(regexp_replace(m.body_text,E'(?m)^>.*$','','g'),
      E'(?is)\\n(on [^\\n]*wrote:|am [^\\n]*schrieb[^\\n]*:|from:|von:)[\\s\\S]*$',''),E'(?is)\\n(--\\s*\\n|sent from my)[\\s\\S]*$',''),1024) end as content
  from public.crm_mailbox_messages m join public.crm_mailbox_links l on l.workspace_id=m.workspace_id and l.user_id=m.user_id and l.message_id=m.id
  join public.contacts c on c.workspace_id=l.workspace_id and c.id=l.contact_id and c.project_id=l.project_id
  where m.workspace_id=p_workspace and l.project_id=p_project and l.contact_id=target.contact_id and l.lead_id=target.lead_id
   and l.confirmed_reply and m.deleted_at is null and m.received_at>=target.created_at
   and lower(trim(m.from_address))=lower(trim(c.email)) and c.archived_at is null and c.organization_id=target.company_id
   and (p_message is null or m.id=p_message)
  order by m.received_at desc,m.id desc limit 25
 )
 select s.id,s.user_id,s.received_at,
  encode(sha256(convert_to(s.id::text||':'||s.revision::text||':'||case when s.shared then s.content else 'UNSHARED' end,'UTF8')),'hex'),
  case when not s.shared then 'UNCLEAR'
   when lower(s.content) ~ '(ignore (previous|all|system)|system prompt|reveal (secret|token)|send (credentials|password))' then 'UNCLEAR'
   when lower(s.content) ~ '(unsubscribe|remove me|do not contact|stop emailing|keine weiteren|nicht mehr kontaktieren|abmelden)' then 'OPT_OUT'
   when lower(s.content) ~ '(out of (the )?office|automatic reply|auto.?reply|abwesenheits|on (annual )?leave)' then 'OUT_OF_OFFICE'
   when s.content like '%?%' then 'QUESTION'
   when lower(s.content) ~ '(not interested|kein interesse)' then 'UNCLEAR'
   when lower(s.content) ~ '(i am interested|we are interested|yes please|ich bin interessiert|wir sind interessiert)' then 'INTERESTED'
   else 'UNCLEAR' end,
  s.shared,s.user_id=nullif(current_setting('app.actor_id',true),'')::uuid
 from sources s;
end $$;
revoke all on function crm_website_sales_inbound_source(uuid,uuid,uuid,uuid) from public;
grant execute on function crm_website_sales_inbound_source(uuid,uuid,uuid,uuid) to novalure_tenant_app;

-- Explicit additional lifecycle capabilities, never a wildcard or customer-acceptance right.
alter table crm_website_sales_machine_grants drop constraint crm_website_sales_machine_grants_scopes_check;
alter table crm_website_sales_machine_grants add constraint crm_website_sales_machine_grants_scopes_check check(cardinality(scopes)>0 and scopes <@ array[
 'crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile',
 'crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo',
 'crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff']::text[]);
alter table crm_website_sales_machine_events drop constraint crm_website_sales_machine_events_action_check;
alter table crm_website_sales_machine_events add constraint crm_website_sales_machine_events_action_check check(action in(
 'crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile',
 'crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo',
 'crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff'));
create or replace function public.crm_lock_website_sales_machine_grant(p_workload uuid,p_grant uuid)
returns setof public.crm_website_sales_machine_grants
language sql volatile security definer set search_path=pg_catalog,public as $function$
 select g.* from public.crm_website_sales_machine_grants g
 join public.crm_website_sales_machine_workloads p on p.id=g.workload_id and p.workspace_id=g.workspace_id
 join public.workspace_users source_actor on source_actor.id=p.actor_user_id and source_actor.workspace_id=p.workspace_id
 join public.workspace_users actor on actor.id=g.actor_user_id and actor.workspace_id=g.workspace_id
 join public.workspaces w on w.id=g.workspace_id
 join public.project_pipeline_permissions project_grant on project_grant.workspace_id=g.workspace_id and project_grant.project_id=g.project_id and project_grant.user_id=g.actor_user_id
 where g.id=p_grant and p.id=p_workload and not g.disabled and g.revoked_at is null
  and g.not_before<=clock_timestamp() and(g.expires_at is null or g.expires_at>clock_timestamp())
  and not p.disabled and not p.kill_switch_active and p.revoked_at is null and p.not_before<=clock_timestamp() and(p.expires_at is null or p.expires_at>clock_timestamp())
  and source_actor.status='active' and source_actor.role='agent' and source_actor.product_role='novalure_operator'
  and actor.status='active' and actor.role='agent' and actor.product_role in('novalure_operator','novalure_sales')
  and w.operating_model='novalure_internal' and project_grant.can_read
  and(g.scopes <@ array['crm.website-sales.read','crm.website-sales.studio.read','crm.website-sales.lifecycle.read']::text[] or project_grant.can_edit_deals)
  and exists(select 1 from public.projects project join public.organizations company on company.workspace_id=project.workspace_id and company.project_id=project.id
    where project.workspace_id=g.workspace_id and project.id=g.project_id and company.id=g.company_id and project.division='WEB_DESIGN'
     and project.data_classification='NOVALURE_INTERNAL' and project.data_purpose='crm_sales' and company.data_classification='NOVALURE_INTERNAL' and company.data_purpose='crm_sales')
  and(g.location_id is null or exists(select 1 from public.crm_company_locations location where location.workspace_id=g.workspace_id and location.project_id=g.project_id and location.company_id=g.company_id and location.id=g.location_id))
 for share of g,p,source_actor,actor,w,project_grant
$function$;
