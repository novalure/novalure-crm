-- Canonical internal Sales operations. No workload, policy, budget or active right is seeded.
begin;
set local lock_timeout='5s';
set local statement_timeout='2min';

create table crm_website_sales_ops_policies(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,policy_group_id uuid not null,
 kind text not null check(kind in('PORTFOLIO','PRICING','IMPROVEMENT')),label text not null check(length(label) between 1 and 200),
 version integer not null check(version>0),policy jsonb not null check(jsonb_typeof(policy)='object' and octet_length(policy::text)<=24000),settings jsonb not null default '{}' check(jsonb_typeof(settings)='object' and octet_length(settings::text)<=24000),
 policy_digest text not null check(policy_digest ~ '^[a-f0-9]{64}$'),created_by uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,project_id,id),unique(workspace_id,policy_group_id,version),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_portfolios(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,title text not null check(length(title) between 1 and 200),
 version integer not null default 1 check(version>0),policy_id uuid not null,budget_minor bigint not null check(budget_minor between 0 and 9007199254740991),
 capacity_minutes bigint not null check(capacity_minutes between 0 and 9007199254740991),window_start timestamptz not null,window_end timestamptz not null,
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 check(window_end>window_start),unique(workspace_id,id),unique(workspace_id,project_id),
 foreign key(workspace_id,project_id,policy_id) references crm_website_sales_ops_policies(workspace_id,project_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_assignments(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 portfolio_id uuid not null,origin jsonb not null check(jsonb_typeof(origin)='object'),attribution_digest text not null check(attribution_digest ~ '^[a-f0-9]{64}$'),
 entered_at timestamptz not null default clock_timestamp(),created_by uuid not null,
 unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),unique(workspace_id,portfolio_id,workflow_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,portfolio_id) references crm_website_sales_ops_portfolios(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_allocations(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 portfolio_id uuid not null,assignment_id uuid not null,version integer not null default 1 check(version>0),stage text not null check(stage in('DIAGNOSIS','CONCEPT','CONCEPT_ACCEPTANCE','DEMO','CONVERSATION')),
 amount_minor bigint not null check(amount_minor between 0 and 9007199254740991),capacity_minutes bigint not null check(capacity_minutes between 1 and 9007199254740991),
 status text not null default 'RESERVED' check(status in('RESERVED','CLAIMED','COMPLETED','RELEASED')),
 expires_at timestamptz not null,lease_token uuid,claimed_by uuid,sealed_command jsonb,sealed_digest text,stage_operation_id uuid,
 decision jsonb not null check(jsonb_typeof(decision)='object' and octet_length(decision::text)<=16000),created_by uuid not null,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,assignment_id) references crm_website_sales_ops_assignments(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,portfolio_id) references crm_website_sales_ops_portfolios(workspace_id,id),
 foreign key(workspace_id,claimed_by) references workspace_users(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 check((status='RESERVED' and lease_token is null and sealed_command is null and stage_operation_id is null) or status<>'RESERVED'),
 check(sealed_digest is null or sealed_digest ~ '^[a-f0-9]{64}$'),check(sealed_command is null or octet_length(sealed_command::text)<=131072)
);
create unique index website_sales_ops_one_reservation on crm_website_sales_ops_allocations(workspace_id,workflow_id,stage) where status in('RESERVED','CLAIMED');
create table crm_website_sales_ops_resource_controls(
 workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,portfolio_id uuid not null,
 require_allocation boolean not null default true check(require_allocation),created_by uuid not null,created_at timestamptz not null default clock_timestamp(),
 primary key(workspace_id,project_id,company_id,location_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,portfolio_id) references crm_website_sales_ops_portfolios(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_effects(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 allocation_id uuid not null,allocation_version integer not null,command_id uuid not null,idempotency_key uuid not null,sealed_digest text not null,
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),unique(workspace_id,allocation_id),unique(workspace_id,command_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,allocation_id) references crm_website_sales_ops_allocations(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_quotes(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 rule_id uuid not null,rule_version integer not null,version integer not null default 1 check(version>0),
 status text not null default 'PROPOSED' check(status in('PROPOSED','APPLIED')),quote jsonb not null check(jsonb_typeof(quote)='object' and octet_length(quote::text)<=48000),
 quote_digest text not null check(quote_digest ~ '^[a-f0-9]{64}$'),offer_id uuid not null,offer_version integer not null,offer_revision integer not null,offer_digest text not null,
 applied_at timestamptz,created_by uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,project_id,rule_id) references crm_website_sales_ops_policies(workspace_id,project_id,id),
 foreign key(workspace_id,offer_id) references crm_offers(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_financial_sources(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 assignment_id uuid not null,source_system text not null,record_id text not null,economic_event_id uuid not null,record_version integer not null check(record_version>0),
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),source jsonb not null check(jsonb_typeof(source)='object' and octet_length(source::text)<=12000),
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),unique(workspace_id,id),
 unique(workspace_id,source_system,record_id,record_version),unique(workspace_id,economic_event_id,record_version),
 unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,assignment_id) references crm_website_sales_ops_assignments(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 check(source->>'sourceConfidence' in('OPERATOR_RECORDED_FINANCIAL_DOCUMENT','CRM_CANONICAL_EVENT')),check(source->>'sourceId'=id::text)
);
create table crm_website_sales_ops_outcomes(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 source_id uuid not null,source_digest text not null,event jsonb not null check(jsonb_typeof(event)='object' and octet_length(event::text)<=16000),
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),unique(workspace_id,source_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,source_id) references crm_website_sales_ops_financial_sources(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_improvements(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,version integer not null default 1 check(version>0),
 candidate_digest text not null check(candidate_digest ~ '^[a-f0-9]{64}$'),candidate jsonb not null check(jsonb_typeof(candidate)='object' and octet_length(candidate::text)<=48000),
 target_policy_id uuid not null,created_by uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,project_id,id),
 foreign key(workspace_id,project_id,target_policy_id) references crm_website_sales_ops_policies(workspace_id,project_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_decisions(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,improvement_id uuid not null,proposal_version integer not null,version integer not null check(version>0),
 candidate_digest text not null,decision text not null check(decision in('APPROVED','REJECTED')),policy_id uuid,
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=48000),valid_until timestamptz not null,
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),unique(workspace_id,id),
 foreign key(workspace_id,project_id,improvement_id) references crm_website_sales_ops_improvements(workspace_id,project_id,id),
 foreign key(workspace_id,project_id,policy_id) references crm_website_sales_ops_policies(workspace_id,project_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table crm_website_sales_ops_activations(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,policy_id uuid not null,decision_id uuid,
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),unique(workspace_id,policy_id),
 foreign key(workspace_id,project_id,policy_id) references crm_website_sales_ops_policies(workspace_id,project_id,id),
 foreign key(workspace_id,decision_id) references crm_website_sales_ops_decisions(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);

-- Quote acceptance is a separate exact-version binding; old append-only records remain history.
alter table crm_website_sales_customer_acceptances add column accepted_quote_id uuid,add column accepted_offer_id uuid,
 add column accepted_offer_version integer,add column accepted_offer_revision integer,add column accepted_offer_digest text;
alter table crm_website_sales_customer_acceptances add foreign key(workspace_id,project_id,company_id,location_id,workflow_id,accepted_quote_id)
 references crm_website_sales_ops_quotes(workspace_id,project_id,company_id,location_id,workflow_id,id);
alter table crm_website_sales_customer_acceptances add check((accepted_offer_id is null and accepted_offer_version is null and accepted_offer_revision is null and accepted_offer_digest is null)
 or (accepted_offer_id is not null and accepted_offer_version>0 and accepted_offer_revision>0 and accepted_offer_digest ~ '^[a-f0-9]{64}$'));

create function crm_sales_ops_owner(p_workspace uuid) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from workspace_users where workspace_id=p_workspace and id=nullif(current_setting('app.actor_id',true),'')::uuid and status='active' and role='owner')
$$;
revoke all on function crm_sales_ops_owner(uuid) from public;
grant execute on function crm_sales_ops_owner(uuid) to novalure_tenant_app;

do $$ declare r text;begin
 foreach r in array array['crm_website_sales_ops_policies','crm_website_sales_ops_portfolios','crm_website_sales_ops_assignments','crm_website_sales_ops_allocations',
  'crm_website_sales_ops_resource_controls','crm_website_sales_ops_effects','crm_website_sales_ops_quotes','crm_website_sales_ops_financial_sources',
  'crm_website_sales_ops_outcomes','crm_website_sales_ops_improvements','crm_website_sales_ops_decisions','crm_website_sales_ops_activations'] loop
  execute format('alter table %I add column data_classification text not null default ''UNCLASSIFIED'',add column data_purpose text not null default ''crm_sales''',r);
  execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',r);
  execute format('alter table %I enable row level security',r);execute format('alter table %I force row level security',r);
  execute format('create policy sales_ops_scope on %I for all to novalure_tenant_app using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',r);
  execute format('create policy sales_ops_insert_actor on %I as restrictive for insert to novalure_tenant_app with check(created_by=nullif(current_setting(''app.actor_id'',true),'''')::uuid)',r);
  execute format('revoke all on %I from public',r);execute format('grant select,insert on %I to novalure_tenant_app',r);
  if r not in('crm_website_sales_ops_portfolios','crm_website_sales_ops_allocations','crm_website_sales_ops_quotes') then
   execute format('create trigger sales_ops_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',r);
  end if;
 end loop;
 foreach r in array array['crm_website_sales_ops_policies','crm_website_sales_ops_portfolios','crm_website_sales_ops_resource_controls','crm_website_sales_ops_financial_sources','crm_website_sales_ops_decisions'] loop
  execute format('create policy sales_ops_owner_insert on %I as restrictive for insert to novalure_tenant_app with check(crm_sales_ops_owner(workspace_id))',r);
 end loop;
end $$;
alter table crm_website_sales_ops_effects add foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred;
grant update(version,policy_id,budget_minor,capacity_minutes,window_start,window_end,title,updated_at) on crm_website_sales_ops_portfolios to novalure_tenant_app;
grant update(version,status,expires_at,lease_token,claimed_by,sealed_command,sealed_digest,stage_operation_id,updated_at) on crm_website_sales_ops_allocations to novalure_tenant_app;
grant update(version,status,offer_version,offer_revision,offer_digest,applied_at) on crm_website_sales_ops_quotes to novalure_tenant_app;

create policy sales_ops_policy_activation on crm_website_sales_ops_activations as restrictive for insert to novalure_tenant_app with check(
 crm_sales_ops_owner(workspace_id) or exists(select 1 from crm_website_sales_ops_decisions d join workspace_users u on u.workspace_id=d.workspace_id and u.id=d.created_by
 where d.workspace_id=crm_website_sales_ops_activations.workspace_id and d.id=decision_id and d.policy_id=crm_website_sales_ops_activations.policy_id
 and d.project_id=crm_website_sales_ops_activations.project_id and d.decision='APPROVED' and d.valid_until>clock_timestamp() and u.role='owner' and u.status='active' and not exists(select 1 from crm_website_sales_ops_decisions newer where newer.workspace_id=d.workspace_id and newer.improvement_id=d.improvement_id and newer.version>d.version)));

create function crm_sales_ops_mutation() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op<>'UPDATE' then raise exception using errcode='42501',message='Sales operations history is preserved';end if;
 if new.version<>old.version+1 then raise exception using errcode='40001',message='Sales operation CAS required';end if;
 if tg_table_name='crm_website_sales_ops_portfolios' then
  if not crm_sales_ops_owner(new.workspace_id) and
   ((to_jsonb(new)-array['version','policy_id','updated_at']) is distinct from (to_jsonb(old)-array['version','policy_id','updated_at']) or
    (new.policy_id<>old.policy_id and not exists(select 1 from crm_website_sales_ops_activations a join crm_website_sales_ops_decisions d on d.workspace_id=a.workspace_id and d.id=a.decision_id
      where a.workspace_id=new.workspace_id and a.policy_id=new.policy_id and d.snapshot->>'targetPolicyId'=old.policy_id::text and d.decision='APPROVED' and d.valid_until>clock_timestamp()
       and not exists(select 1 from crm_website_sales_ops_decisions n where n.workspace_id=d.workspace_id and n.improvement_id=d.improvement_id and n.version>d.version))))
   then raise exception using errcode='42501',message='Owner controls portfolio resources and exact reviewed policy';end if;
  if (to_jsonb(new)-array['version','policy_id','budget_minor','capacity_minutes','window_start','window_end','title','updated_at']) is distinct from
     (to_jsonb(old)-array['version','policy_id','budget_minor','capacity_minutes','window_start','window_end','title','updated_at']) then raise exception using errcode='42501',message='Immutable portfolio identity';end if;
 elsif tg_table_name='crm_website_sales_ops_allocations' then
  if (to_jsonb(new)-array['version','status','expires_at','lease_token','claimed_by','sealed_command','sealed_digest','stage_operation_id','updated_at']) is distinct from
     (to_jsonb(old)-array['version','status','expires_at','lease_token','claimed_by','sealed_command','sealed_digest','stage_operation_id','updated_at'])
   or not((old.status='RESERVED' and new.status in('CLAIMED','RELEASED')) or(old.status='CLAIMED' and new.status in('COMPLETED','RELEASED'))) then raise exception using errcode='42501',message='Immutable allocation or invalid transition';end if;
 else
  if old.status<>'PROPOSED' or new.status<>'APPLIED' or (to_jsonb(new)-array['version','status','offer_version','offer_revision','offer_digest','applied_at']) is distinct from
    (to_jsonb(old)-array['version','status','offer_version','offer_revision','offer_digest','applied_at']) then raise exception using errcode='42501',message='Quote application is immutable';end if;
 end if;
 return new;
end $$;
do $$ declare r text;begin foreach r in array array['crm_website_sales_ops_portfolios','crm_website_sales_ops_allocations','crm_website_sales_ops_quotes'] loop
 execute format('create trigger sales_ops_mutation before update or delete on %I for each row execute function crm_sales_ops_mutation()',r);
 execute format('create trigger sales_ops_no_truncate before truncate on %I for each statement execute function crm_reject_immutable_mutation()',r);
end loop;end $$;

alter table crm_website_sales_machine_grants drop constraint crm_website_sales_machine_grants_scopes_check;
alter table crm_website_sales_machine_grants add constraint crm_website_sales_machine_grants_scopes_check check(cardinality(scopes)>0 and scopes <@ array[
 'crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile',
 'crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo',
 'crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff','crm.website-sales.autonomy.read','crm.website-sales.autonomy.plan-portfolio','crm.website-sales.autonomy.claim-allocation','crm.website-sales.autonomy.settle-allocation','crm.website-sales.autonomy.propose-price','crm.website-sales.autonomy.apply-quote','crm.website-sales.autonomy.record-outcome','crm.website-sales.autonomy.propose-improvement','crm.website-sales.autonomy.promote-improvement','crm.website-sales.conversation.read','crm.website-sales.conversation.record-topic','crm.website-sales.conversation.draft-answer','crm.website-sales.conversation.advance-conversation','crm.website-sales.conversation.stop-conversation']::text[]);
alter table crm_website_sales_machine_events drop constraint crm_website_sales_machine_events_action_check;
alter table crm_website_sales_machine_events add constraint crm_website_sales_machine_events_action_check check(action in(
 'crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile',
 'crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo',
 'crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff','crm.website-sales.autonomy.read','crm.website-sales.autonomy.plan-portfolio','crm.website-sales.autonomy.claim-allocation','crm.website-sales.autonomy.settle-allocation','crm.website-sales.autonomy.propose-price','crm.website-sales.autonomy.apply-quote','crm.website-sales.autonomy.record-outcome','crm.website-sales.autonomy.propose-improvement','crm.website-sales.autonomy.promote-improvement','crm.website-sales.conversation.read','crm.website-sales.conversation.record-topic','crm.website-sales.conversation.draft-answer','crm.website-sales.conversation.advance-conversation','crm.website-sales.conversation.stop-conversation'));
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
  and(g.scopes <@ array['crm.website-sales.read','crm.website-sales.studio.read','crm.website-sales.lifecycle.read','crm.website-sales.autonomy.read','crm.website-sales.conversation.read']::text[] or project_grant.can_edit_deals)
  and exists(select 1 from public.projects project join public.organizations company on company.workspace_id=project.workspace_id and company.project_id=project.id
    where project.workspace_id=g.workspace_id and project.id=g.project_id and company.id=g.company_id and project.division='WEB_DESIGN'
     and project.data_classification='NOVALURE_INTERNAL' and project.data_purpose='crm_sales' and company.data_classification='NOVALURE_INTERNAL' and company.data_purpose='crm_sales')
  and(g.location_id is null or exists(select 1 from public.crm_company_locations location where location.workspace_id=g.workspace_id and location.project_id=g.project_id and location.company_id=g.company_id and location.id=g.location_id))
 for share of g,p,source_actor,actor,w,project_grant
$function$;

-- Lock the actual policy approver without granting a runtime member-table writer.
do $$begin
 execute format('create policy sales_ops_schema_policy_read on crm_website_sales_ops_policies for select to %I using(workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_project_access(workspace_id,project_id,false))',current_user);
end $$;
create function crm_lock_sales_policy_owner(p_workspace uuid,p_policy uuid) returns boolean
language sql volatile security definer set search_path=pg_catalog,public as $$
 select true from workspace_users u where u.workspace_id=p_workspace and u.role='owner' and u.status='active'
 and p_workspace=nullif(current_setting('app.tenant_id',true),'')::uuid
 and exists(select 1 from crm_website_sales_ops_policies p where p.workspace_id=p_workspace and p.id=p_policy and p.created_by=u.id
  and p.policy->'approval'->>'approvedBy'=u.id::text and p.data_classification='NOVALURE_INTERNAL' and crm_project_access(p.workspace_id,p.project_id,false))
 for share of u
$$;
revoke all on function crm_lock_sales_policy_owner(uuid,uuid) from public,novalure_app;
grant execute on function crm_lock_sales_policy_owner(uuid,uuid) to novalure_tenant_app;
commit;
