-- Website Sales commercial execution evidence. No provider, principal, active grant or accounting authority is seeded.
begin;
set local lock_timeout='5s';
set local statement_timeout='2min';
do $$ begin
 if not exists(select 1 from pg_roles where rolname='novalure_website_sales_commerce_executor') then
  create role novalure_website_sales_commerce_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if exists(select 1 from pg_roles where rolname='novalure_website_sales_commerce_executor' and(rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication or rolcanlogin)) then raise exception 'Unsafe commerce executor role';end if;
end $$;
create table crm_website_sales_commerce(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 version integer not null check(version>0),last_command_id uuid,created_by uuid not null,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,workflow_id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id) references crm_website_sales_workflows(workspace_id,project_id,company_id,location_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
 foreign key(workspace_id,last_command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred
);
create table crm_website_sales_commerce_records(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,commerce_id uuid not null,
 aggregate_version integer not null check(aggregate_version>0),entity_id uuid not null,version integer not null check(version>0),kind text not null,
 workflow_version integer not null check(workflow_version>0),payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=120000),
 record_digest text not null check(record_digest~'^[a-f0-9]{64}$'),previous_digest text check(previous_digest~'^[a-f0-9]{64}$'),
 source_confidence text not null check(source_confidence in('OPERATOR_RECORDED','SERVER_DERIVED','VERIFIED_PROVIDER','VERIFIED_CUSTOMER')),
 created_by uuid not null,command_id uuid,created_at timestamptz not null default clock_timestamp(),valid_until timestamptz,
 unique(workspace_id,id),unique(workspace_id,commerce_id,aggregate_version),unique(workspace_id,commerce_id,entity_id,version),unique(workspace_id,project_id,company_id,location_id,workflow_id,entity_id,version),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,commerce_id) references crm_website_sales_commerce(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check((version=1)=(previous_digest is null)),check(valid_until is null or valid_until>created_at)
);
create index commerce_records_latest on crm_website_sales_commerce_records(workspace_id,workflow_id,kind,aggregate_version desc);
create table crm_website_sales_commerce_jobs(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,commerce_id uuid not null,
 kind text not null check(kind in('OFFER_SEND','CONTRACT_SEND','SIGNATURE_REQUEST','ACCOUNTING_INVOICE_REQUEST','REFUND_REQUEST','SUBSCRIPTION_CHANGE')),
 entity_id uuid not null,entity_version integer not null check(entity_version>0),offer_id uuid,offer_revision integer,
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=120000),payload_digest text not null check(payload_digest~'^[a-f0-9]{64}$'),
 idempotency_key uuid not null unique,command_id uuid not null,created_by uuid not null,
 status text not null default 'READY' check(status in('READY','CLAIMED','ACCEPTED','UNKNOWN','REJECTED','CANCELLED')),
 version integer not null default 1 check(version>0),lease_token uuid,lease_expires_at timestamptz,first_attempt_at timestamptz,last_checked_at timestamptz,provider_reference text,provider_receipt_digest text check(provider_receipt_digest~'^[a-f0-9]{64}$'),error_code text,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,commerce_id) references crm_website_sales_commerce(workspace_id,project_id,company_id,location_id,workflow_id,id),
 foreign key(workspace_id,offer_id) references crm_offers(workspace_id,id),foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check((status='CLAIMED')=(lease_token is not null and lease_expires_at is not null)),check(provider_reference is null or length(provider_reference) between 1 and 250)
);
create unique index commerce_one_active_document_job on crm_website_sales_commerce_jobs(workspace_id,workflow_id,kind,entity_id,entity_version) where status not in('CANCELLED','REJECTED');
create index commerce_due_jobs on crm_website_sales_commerce_jobs(workspace_id,workflow_id,status,created_at);
create table crm_website_sales_commerce_sources(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,job_id uuid not null,
 provider text not null,account_reference text not null,event_id text not null,kind text not null,event_digest text not null check(event_digest~'^[a-f0-9]{64}$'),
 entity_id uuid not null,entity_version integer not null check(entity_version>0),document_digest text not null check(document_digest~'^[a-f0-9]{64}$'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=120000),occurred_at timestamptz not null,received_at timestamptz not null default clock_timestamp(),
 unique(provider,account_reference,event_id),unique(workspace_id,id),unique(workspace_id,job_id,kind,event_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,job_id) references crm_website_sales_commerce_jobs(workspace_id,project_id,company_id,location_id,workflow_id,id)
);
create table crm_website_sales_commerce_approvals(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 document_id uuid not null,document_version integer not null,document_digest text not null check(document_digest~'^[a-f0-9]{64}$'),recipient_digest text not null check(recipient_digest~'^[a-f0-9]{64}$'),
 total_net_minor bigint not null check(total_net_minor>=0),tax_digest text not null check(tax_digest~'^[a-f0-9]{64}$'),required_steps integer not null check(required_steps in(1,2)),
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,command_id uuid not null,
 unique(workspace_id,id),foreign key(workspace_id,project_id,company_id,location_id,workflow_id,document_id,document_version) references crm_website_sales_commerce_records(workspace_id,project_id,company_id,location_id,workflow_id,entity_id,version),
 foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred,
 check(expires_at>created_at)
);
create table crm_website_sales_commerce_approval_steps(
 id uuid primary key,workspace_id uuid not null,approval_id uuid not null,step_number integer not null check(step_number in(1,2)),challenge_id uuid not null,
 actor_id uuid not null,auth_session_id uuid not null,auth_identity_id uuid not null,mfa_verified_at timestamptz not null,decision text not null check(decision in('APPROVED','REVOKED')),
 previous_step_digest text,step_digest text not null check(step_digest~'^[a-f0-9]{64}$'),command_id uuid not null,created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,approval_id,step_number,decision),unique(workspace_id,approval_id,challenge_id),
 foreign key(workspace_id,approval_id) references crm_website_sales_commerce_approvals(workspace_id,id),foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
 foreign key(workspace_id,command_id) references crm_command_receipts(workspace_id,id) deferrable initially deferred
);
create table crm_website_sales_commerce_allocations(
 id uuid primary key,workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 source_id uuid not null,invoice_id uuid not null,invoice_version integer not null,installment_id uuid not null,kind text not null check(kind in('PAYMENT','REFUND','REVERSAL')),amount_minor bigint not null check(amount_minor>0),
 currency text not null check(currency='EUR'),reverses_id uuid,created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,source_id,invoice_id,installment_id),foreign key(workspace_id,source_id) references crm_website_sales_commerce_sources(workspace_id,id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,invoice_id,invoice_version) references crm_website_sales_commerce_records(workspace_id,project_id,company_id,location_id,workflow_id,entity_id,version),
 foreign key(workspace_id,reverses_id) references crm_website_sales_commerce_allocations(workspace_id,id)
);
alter table crm_website_sales_commerce enable row level security;alter table crm_website_sales_commerce force row level security;
create policy commerce_read on crm_website_sales_commerce for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy commerce_executor on crm_website_sales_commerce for all to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
revoke all on crm_website_sales_commerce from public;grant select on crm_website_sales_commerce to novalure_tenant_app;grant select,insert on crm_website_sales_commerce to novalure_website_sales_commerce_executor;
create policy commerce_insert on crm_website_sales_commerce for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));grant insert on crm_website_sales_commerce to novalure_tenant_app;
grant update on crm_website_sales_commerce to novalure_website_sales_commerce_executor;grant update on crm_website_sales_commerce to novalure_tenant_app;create policy commerce_update on crm_website_sales_commerce for update to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true)) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));
create trigger commerce_no_delete before delete or truncate on crm_website_sales_commerce for each statement execute function crm_reject_immutable_mutation();
alter table crm_website_sales_commerce_records enable row level security;alter table crm_website_sales_commerce_records force row level security;
create policy commerce_read on crm_website_sales_commerce_records for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy commerce_executor on crm_website_sales_commerce_records for all to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
revoke all on crm_website_sales_commerce_records from public;grant select on crm_website_sales_commerce_records to novalure_tenant_app;grant select,insert on crm_website_sales_commerce_records to novalure_website_sales_commerce_executor;
create policy commerce_insert on crm_website_sales_commerce_records for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true) and created_by=nullif(current_setting('app.actor_id',true),'')::uuid);grant insert on crm_website_sales_commerce_records to novalure_tenant_app;
create trigger commerce_immutable before update or delete or truncate on crm_website_sales_commerce_records for each statement execute function crm_reject_immutable_mutation();
alter table crm_website_sales_commerce_jobs enable row level security;alter table crm_website_sales_commerce_jobs force row level security;
create policy commerce_read on crm_website_sales_commerce_jobs for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy commerce_executor on crm_website_sales_commerce_jobs for all to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
revoke all on crm_website_sales_commerce_jobs from public;grant select on crm_website_sales_commerce_jobs to novalure_tenant_app;grant select,insert on crm_website_sales_commerce_jobs to novalure_website_sales_commerce_executor;
create policy commerce_insert on crm_website_sales_commerce_jobs for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));grant insert on crm_website_sales_commerce_jobs to novalure_tenant_app;
grant update on crm_website_sales_commerce_jobs to novalure_website_sales_commerce_executor;grant update on crm_website_sales_commerce_jobs to novalure_tenant_app;create policy commerce_update on crm_website_sales_commerce_jobs for update to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true)) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));
create trigger commerce_no_delete before delete or truncate on crm_website_sales_commerce_jobs for each statement execute function crm_reject_immutable_mutation();
alter table crm_website_sales_commerce_sources enable row level security;alter table crm_website_sales_commerce_sources force row level security;
create policy commerce_read on crm_website_sales_commerce_sources for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy commerce_executor on crm_website_sales_commerce_sources for all to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
revoke all on crm_website_sales_commerce_sources from public;grant select on crm_website_sales_commerce_sources to novalure_tenant_app;grant select,insert on crm_website_sales_commerce_sources to novalure_website_sales_commerce_executor;
create trigger commerce_immutable before update or delete or truncate on crm_website_sales_commerce_sources for each statement execute function crm_reject_immutable_mutation();
alter table crm_website_sales_commerce_approvals enable row level security;alter table crm_website_sales_commerce_approvals force row level security;
create policy commerce_read on crm_website_sales_commerce_approvals for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy commerce_executor on crm_website_sales_commerce_approvals for all to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
revoke all on crm_website_sales_commerce_approvals from public;grant select on crm_website_sales_commerce_approvals to novalure_tenant_app;grant select,insert on crm_website_sales_commerce_approvals to novalure_website_sales_commerce_executor;
create policy commerce_insert on crm_website_sales_commerce_approvals for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true) and created_by=nullif(current_setting('app.actor_id',true),'')::uuid);grant insert on crm_website_sales_commerce_approvals to novalure_tenant_app;
create trigger commerce_immutable before update or delete or truncate on crm_website_sales_commerce_approvals for each statement execute function crm_reject_immutable_mutation();
alter table crm_website_sales_commerce_approval_steps enable row level security;alter table crm_website_sales_commerce_approval_steps force row level security;
create policy commerce_read on crm_website_sales_commerce_approval_steps for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and exists(select 1 from crm_website_sales_commerce_approvals a where a.workspace_id=crm_website_sales_commerce_approval_steps.workspace_id and a.id=crm_website_sales_commerce_approval_steps.approval_id and crm_project_access(a.workspace_id,a.project_id,false)));
create policy commerce_executor on crm_website_sales_commerce_approval_steps for all to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
revoke all on crm_website_sales_commerce_approval_steps from public;grant select on crm_website_sales_commerce_approval_steps to novalure_tenant_app;grant select,insert on crm_website_sales_commerce_approval_steps to novalure_website_sales_commerce_executor;
create policy commerce_insert on crm_website_sales_commerce_approval_steps for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid and exists(select 1 from crm_website_sales_commerce_approvals a where a.workspace_id=crm_website_sales_commerce_approval_steps.workspace_id and a.id=crm_website_sales_commerce_approval_steps.approval_id and crm_sales_ops_owner(a.workspace_id)));grant insert on crm_website_sales_commerce_approval_steps to novalure_tenant_app;
create trigger commerce_immutable before update or delete or truncate on crm_website_sales_commerce_approval_steps for each statement execute function crm_reject_immutable_mutation();
alter table crm_website_sales_commerce_allocations enable row level security;alter table crm_website_sales_commerce_allocations force row level security;
create policy commerce_read on crm_website_sales_commerce_allocations for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy commerce_executor on crm_website_sales_commerce_allocations for all to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
revoke all on crm_website_sales_commerce_allocations from public;grant select on crm_website_sales_commerce_allocations to novalure_tenant_app;grant select,insert on crm_website_sales_commerce_allocations to novalure_website_sales_commerce_executor;
create trigger commerce_immutable before update or delete or truncate on crm_website_sales_commerce_allocations for each statement execute function crm_reject_immutable_mutation();

-- Runtime SQL cannot directly fabricate verified event provenance or financial allocations.
grant usage on schema public to novalure_website_sales_commerce_executor;
-- Current canonical reads only; the source role has no inherited CRM write role.
grant select on workspace_users to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on workspace_users for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on workspaces to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on workspaces for select to novalure_website_sales_commerce_executor using(id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on projects to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on projects for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on project_pipeline_permissions to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on project_pipeline_permissions for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on organizations to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on organizations for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on contacts to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on contacts for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_company_locations to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on crm_company_locations for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_website_sales_workflows to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on crm_website_sales_workflows for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_offers to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on crm_offers for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_offer_revisions to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on crm_offer_revisions for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_offer_approvals to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on crm_offer_approvals for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

grant select(id,auth_identity_id,workspace_id,workspace_user_id,mfa_verified_at,created_at,expires_at,revoked_at) on auth_sessions to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on auth_sessions for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

-- Immutable proposal/status boundaries apply even to direct runtime SQL.
create function crm_website_sales_commerce_mutation_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_table_name='crm_website_sales_commerce' then
  if (new.id,new.workspace_id,new.project_id,new.company_id,new.location_id,new.workflow_id,new.created_by,new.created_at) is distinct from (old.id,old.workspace_id,old.project_id,old.company_id,old.location_id,old.workflow_id,old.created_by,old.created_at) or new.version<>old.version+1 then raise exception using errcode='23514',message='Immutable commercial scope and exact version required';end if;
 elsif (new.id,new.workspace_id,new.project_id,new.company_id,new.location_id,new.workflow_id,new.commerce_id,new.kind,new.entity_id,new.entity_version,new.offer_id,new.offer_revision,new.payload,new.payload_digest,new.idempotency_key,new.command_id,new.created_by,new.created_at) is distinct from (old.id,old.workspace_id,old.project_id,old.company_id,old.location_id,old.workflow_id,old.commerce_id,old.kind,old.entity_id,old.entity_version,old.offer_id,old.offer_revision,old.payload,old.payload_digest,old.idempotency_key,old.command_id,old.created_by,old.created_at) or new.version<>old.version+1 then raise exception using errcode='23514',message='Immutable outbox and exact version required';
 elsif not pg_has_role(current_user,'novalure_website_sales_commerce_executor','USAGE') and not(old.status='READY' and new.status='CANCELLED') then raise exception using errcode='42501',message='Verified executor owns outbox outcomes';end if;
 return new;
end $$;
create trigger commerce_version_guard before update on crm_website_sales_commerce for each row execute function crm_website_sales_commerce_mutation_guard();
create trigger commerce_job_guard before update on crm_website_sales_commerce_jobs for each row execute function crm_website_sales_commerce_mutation_guard();
create policy commerce_job_ready_only on crm_website_sales_commerce_jobs as restrictive for insert to novalure_tenant_app with check(status='READY' and version=1 and lease_token is null and provider_reference is null and first_attempt_at is null and created_by=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy commerce_record_confidence on crm_website_sales_commerce_records as restrictive for insert to novalure_tenant_app with check(
 source_confidence in('OPERATOR_RECORDED','SERVER_DERIVED') and created_by=nullif(current_setting('app.actor_id',true),'')::uuid and
 ((kind in('TEMPLATE','POLICY','DELIVERY_ACCEPTANCE','SUBSCRIPTION_TERMS','CANCELLATION_REQUEST') and source_confidence='OPERATOR_RECORDED' and crm_sales_ops_owner(workspace_id))
 or(kind in('CONTRACT','INVOICE_REQUEST','RENEWAL_PROPOSAL') and source_confidence='SERVER_DERIVED')));
create policy commerce_approval_owner on crm_website_sales_commerce_approvals as restrictive for insert to novalure_tenant_app with check(crm_sales_ops_owner(workspace_id));
alter table crm_website_sales_commerce_approvals add check(required_steps=case when total_net_minor>=500000 then 2 else 1 end);
revoke insert on crm_website_sales_commerce_approvals,crm_website_sales_commerce_approval_steps from novalure_website_sales_commerce_executor;
create function crm_website_sales_commerce_step_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare previous public.crm_website_sales_commerce_approval_steps; required integer;
begin
 if new.actor_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or not crm_sales_ops_owner(new.workspace_id) then raise exception using errcode='42501',message='Actual owner approval required';end if;
 perform id from auth_sessions where id=new.auth_session_id and auth_identity_id=new.auth_identity_id and workspace_id=new.workspace_id and workspace_user_id=new.actor_id and revoked_at is null and expires_at>clock_timestamp() and mfa_verified_at=new.mfa_verified_at and mfa_verified_at between clock_timestamp()-interval '15 minutes' and clock_timestamp() for share;
 if not found then raise exception using errcode='42501',message='Fresh actual MFA session required';end if;
 select required_steps into required from crm_website_sales_commerce_approvals where workspace_id=new.workspace_id and id=new.approval_id and(expires_at>clock_timestamp() or new.decision='REVOKED');
 if not found or new.step_number>required then raise exception using errcode='23514',message='Current exact approval required';end if;
 if new.decision='APPROVED' and new.step_number=2 then
  select * into previous from crm_website_sales_commerce_approval_steps where workspace_id=new.workspace_id and approval_id=new.approval_id and step_number=1 and decision='APPROVED';
  if previous.id is null or previous.auth_session_id=new.auth_session_id or previous.challenge_id=new.challenge_id or previous.step_digest is distinct from new.previous_step_digest or new.mfa_verified_at<=previous.created_at then raise exception using errcode='23514',message='Independent fresh approval step required';end if;
 elsif new.decision='APPROVED' and new.previous_step_digest is not null then raise exception using errcode='23514',message='Invalid approval chain';end if;
 return new;
end $$;
create trigger commerce_step_guard before insert on crm_website_sales_commerce_approval_steps for each row execute function crm_website_sales_commerce_step_guard();
-- A provider-uncertain effect cannot be changed, duplicated, or overwritten by the legacy manual path.
create function crm_website_sales_commerce_offer_fence() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare target uuid; w uuid;
begin
 if tg_table_name='crm_offers' then target:=old.id;w:=old.workspace_id;else target:=new.offer_id;w:=new.workspace_id;end if;
 if exists(select 1 from crm_website_sales_commerce_jobs j where j.workspace_id=w and j.offer_id=target and j.status in('CLAIMED','UNKNOWN')) then raise exception using errcode='23514',message='COMMERCE_DELIVERY_OUTCOME_UNKNOWN';end if;
 return new;
end $$;
create trigger commerce_offer_unknown_fence before update on crm_offers for each row execute function crm_website_sales_commerce_offer_fence();
create trigger commerce_delivery_unknown_fence before insert or update on crm_offer_deliveries for each row execute function crm_website_sales_commerce_offer_fence();
revoke all on function crm_website_sales_commerce_mutation_guard(),crm_website_sales_commerce_step_guard(),crm_website_sales_commerce_offer_fence() from public;

grant execute on function crm_lock_website_sales_machine_grant(uuid,uuid) to novalure_website_sales_commerce_executor;
grant select on consent_records to novalure_website_sales_commerce_executor;create policy commerce_executor_read on consent_records for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on newsletter_suppressions to novalure_website_sales_commerce_executor;create policy commerce_executor_read on newsletter_suppressions for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_website_sales_handoffs to novalure_website_sales_commerce_executor;create policy commerce_executor_read on crm_website_sales_handoffs for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on tasks to novalure_website_sales_commerce_executor;create policy commerce_executor_read on tasks for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

alter table crm_offer_deliveries drop constraint crm_offer_deliveries_status_check;
alter table crm_offer_deliveries add constraint crm_offer_deliveries_status_check check(status in('QUEUED','MANUALLY_ATTESTED','UNKNOWN','CANCELLED','PROVIDER_DELIVERED'));
-- Only the separately registered verified event executor may apply real transport evidence.
grant select on crm_offer_deliveries to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on crm_offer_deliveries for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant update(status,version,updated_at) on crm_offers to novalure_website_sales_commerce_executor;
create policy commerce_executor_update on crm_offers for update to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant update(status,receipt_reference,attested_by,attested_at) on crm_offer_deliveries to novalure_website_sales_commerce_executor;
create policy commerce_executor_update on crm_offer_deliveries for update to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

create table crm_website_sales_commerce_challenges(
 id uuid primary key,workspace_id uuid not null,approval_id uuid not null,step_number integer not null check(step_number in(1,2)),actor_id uuid not null,
 auth_session_id uuid not null,auth_identity_id uuid not null,created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 unique(workspace_id,id),foreign key(workspace_id,approval_id) references crm_website_sales_commerce_approvals(workspace_id,id),
 foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),check(expires_at>created_at)
);
alter table crm_website_sales_commerce_challenges enable row level security;alter table crm_website_sales_commerce_challenges force row level security;
create policy commerce_challenge_scope on crm_website_sales_commerce_challenges for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
create policy commerce_challenge_owner on crm_website_sales_commerce_challenges for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and actor_id=nullif(current_setting('app.actor_id',true),'')::uuid and crm_sales_ops_owner(workspace_id));
grant select,insert on crm_website_sales_commerce_challenges to novalure_tenant_app;
create trigger commerce_challenge_immutable before update or delete or truncate on crm_website_sales_commerce_challenges for each statement execute function crm_reject_immutable_mutation();
alter table crm_website_sales_commerce_approval_steps add foreign key(workspace_id,challenge_id) references crm_website_sales_commerce_challenges(workspace_id,id);
grant execute on function crm_offer_configured_approver(uuid) to novalure_website_sales_commerce_executor;
grant select on crm_website_sales_observations to novalure_website_sales_commerce_executor;create policy commerce_executor_read on crm_website_sales_observations for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_website_sales_offer_invalidations to novalure_website_sales_commerce_executor;create policy commerce_executor_read on crm_website_sales_offer_invalidations for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
alter table crm_website_sales_commerce add column data_classification text not null default 'UNCLASSIFIED',add column data_purpose text not null default 'crm_sales';create trigger crm_sales_classification_guard before insert or update on crm_website_sales_commerce for each row execute function crm_set_sales_classification();
alter table crm_website_sales_commerce_records add column data_classification text not null default 'UNCLASSIFIED',add column data_purpose text not null default 'crm_sales';create trigger crm_sales_classification_guard before insert or update on crm_website_sales_commerce_records for each row execute function crm_set_sales_classification();
alter table crm_website_sales_commerce_jobs add column data_classification text not null default 'UNCLASSIFIED',add column data_purpose text not null default 'crm_sales';create trigger crm_sales_classification_guard before insert or update on crm_website_sales_commerce_jobs for each row execute function crm_set_sales_classification();
alter table crm_website_sales_commerce_sources add column data_classification text not null default 'UNCLASSIFIED',add column data_purpose text not null default 'crm_sales';create trigger crm_sales_classification_guard before insert or update on crm_website_sales_commerce_sources for each row execute function crm_set_sales_classification();
alter table crm_website_sales_commerce_approvals add column data_classification text not null default 'UNCLASSIFIED',add column data_purpose text not null default 'crm_sales';create trigger crm_sales_classification_guard before insert or update on crm_website_sales_commerce_approvals for each row execute function crm_set_sales_classification();
alter table crm_website_sales_commerce_allocations add column data_classification text not null default 'UNCLASSIFIED',add column data_purpose text not null default 'crm_sales';create trigger crm_sales_classification_guard before insert or update on crm_website_sales_commerce_allocations for each row execute function crm_set_sales_classification();

-- An inaccessible lock owner can take canonical row locks without granting generic UPDATE to the executor login.
do $$begin
 if not exists(select 1 from pg_roles where rolname='novalure_website_sales_commerce_lock_owner') then create role novalure_website_sales_commerce_lock_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;
 if exists(select 1 from pg_roles where rolname='novalure_website_sales_commerce_lock_owner' and(rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication)) then raise exception 'Unsafe commercial lock owner';end if;
end $$;
grant usage on schema public to novalure_website_sales_commerce_lock_owner;
grant execute on function crm_lock_website_sales_machine_grant(uuid,uuid) to novalure_website_sales_commerce_lock_owner;
grant select,update(id) on crm_website_sales_commerce_jobs to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on crm_website_sales_commerce_jobs for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant select,update(id) on crm_website_sales_commerce_approvals to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on crm_website_sales_commerce_approvals for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant select,update(id) on workspace_users to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on workspace_users for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant select,update(id) on contacts to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on contacts for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant select,update(id) on crm_company_locations to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on crm_company_locations for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant select,update(id) on crm_website_sales_workflows to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on crm_website_sales_workflows for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant select,update(id) on crm_offers to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on crm_offers for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant select,update(id) on crm_offer_approvals to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on crm_offer_approvals for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
grant select,update(id) on tasks to novalure_website_sales_commerce_lock_owner;create policy commerce_lock_owner on tasks for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);

grant select on crm_website_sales_handoffs to novalure_website_sales_commerce_lock_owner;
create policy commerce_lock_owner_read on crm_website_sales_handoffs for select to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create function crm_website_sales_commerce_lock_job(p_job uuid,p_workload uuid,p_grant uuid) returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare g public.crm_website_sales_machine_grants;j public.crm_website_sales_commerce_jobs;contact uuid;offer uuid;
begin
 select * into g from crm_lock_website_sales_machine_grant(p_workload,p_grant);
 select * into j from crm_website_sales_commerce_jobs where id=p_job and workspace_id=g.workspace_id;
 if g.id is null or j.id is null or g.actor_user_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid or(g.workspace_id,g.project_id,g.company_id,g.location_id) is distinct from(j.workspace_id,j.project_id,j.company_id,j.location_id) then raise exception using errcode='42501',message='Exact commercial resource authority required';end if;
 perform id from crm_company_locations where workspace_id=j.workspace_id and project_id=j.project_id and company_id=j.company_id and id=j.location_id for share;
 select contact_id,offer_draft_id into contact,offer from crm_website_sales_workflows where workspace_id=j.workspace_id and project_id=j.project_id and company_id=j.company_id and location_id=j.location_id and id=j.workflow_id for share;
 if not found then raise exception using errcode='42501',message='Exact commercial workflow required';end if;
 perform id from deals where workspace_id=j.workspace_id and id in(select deal_id from crm_offers where workspace_id=j.workspace_id and id=j.offer_id) for update;
 perform id from contacts where workspace_id=j.workspace_id and id=contact for update;
 perform id from tasks where workspace_id=j.workspace_id and id in(select task_id from crm_website_sales_handoffs where workspace_id=j.workspace_id and workflow_id=j.workflow_id) for share;
 if j.offer_id is not null then perform id from crm_offers where workspace_id=j.workspace_id and id=j.offer_id for share;end if;
 perform id from crm_offer_approvals where workspace_id=j.workspace_id and offer_id=j.offer_id for share;
 perform id from crm_website_sales_commerce_approvals where workspace_id=j.workspace_id and workflow_id=j.workflow_id for share;
 perform id from workspace_users where workspace_id=j.workspace_id and role='owner' for share;
 return true;
end $$;
grant create on schema public to novalure_website_sales_commerce_lock_owner;
alter function crm_website_sales_commerce_lock_job(uuid,uuid,uuid) owner to novalure_website_sales_commerce_lock_owner;
revoke create on schema public from novalure_website_sales_commerce_lock_owner;
revoke all on function crm_website_sales_commerce_lock_job(uuid,uuid,uuid) from public;
grant execute on function crm_website_sales_commerce_lock_job(uuid,uuid,uuid) to novalure_website_sales_commerce_executor;
alter table crm_website_sales_machine_grants drop constraint crm_website_sales_machine_grants_scopes_check;
alter table crm_website_sales_machine_grants add constraint crm_website_sales_machine_grants_scopes_check check(cardinality(scopes)>0 and scopes <@ array['crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile','crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo','crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff','crm.website-sales.autonomy.read','crm.website-sales.autonomy.plan-portfolio','crm.website-sales.autonomy.claim-allocation','crm.website-sales.autonomy.settle-allocation','crm.website-sales.autonomy.propose-price','crm.website-sales.autonomy.apply-quote','crm.website-sales.autonomy.record-outcome','crm.website-sales.autonomy.propose-improvement','crm.website-sales.autonomy.promote-improvement','crm.website-sales.conversation.read','crm.website-sales.conversation.record-topic','crm.website-sales.conversation.draft-answer','crm.website-sales.conversation.advance-conversation','crm.website-sales.conversation.stop-conversation','crm.website-sales.enablement.read','crm.website-sales.enablement.propose-next-step','crm.website-sales.enablement.propose-care','crm.website-sales.enablement.prepare-care-offer','crm.website-sales.enablement.scan-hygiene','crm.website-sales.commerce.read','crm.website-sales.commerce.reconcile','crm.website-sales.commerce.prepare-contract','crm.website-sales.commerce.queue-offer-delivery','crm.website-sales.commerce.queue-contract-delivery','crm.website-sales.commerce.request-signature','crm.website-sales.commerce.prepare-invoice-request','crm.website-sales.commerce.propose-renewal','crm.website-sales.commerce.ingest-source']::text[]);
alter table crm_website_sales_machine_events drop constraint crm_website_sales_machine_events_action_check;
alter table crm_website_sales_machine_events add constraint crm_website_sales_machine_events_action_check check(action in('crm.website-sales.read','crm.website-sales.register-location','crm.website-sales.observe','crm.website-sales.qualify','crm.website-sales.prepare-draft','crm.website-sales.stop','crm.website-sales.reconcile','crm.website-sales.studio.read','crm.website-sales.studio.create-diagnosis','crm.website-sales.studio.create-concept','crm.website-sales.studio.accept-concept','crm.website-sales.studio.build-demo','crm.website-sales.lifecycle.read','crm.website-sales.lifecycle.refresh-evidence','crm.website-sales.lifecycle.ingest-reply','crm.website-sales.lifecycle.create-handoff','crm.website-sales.autonomy.read','crm.website-sales.autonomy.plan-portfolio','crm.website-sales.autonomy.claim-allocation','crm.website-sales.autonomy.settle-allocation','crm.website-sales.autonomy.propose-price','crm.website-sales.autonomy.apply-quote','crm.website-sales.autonomy.record-outcome','crm.website-sales.autonomy.propose-improvement','crm.website-sales.autonomy.promote-improvement','crm.website-sales.conversation.read','crm.website-sales.conversation.record-topic','crm.website-sales.conversation.draft-answer','crm.website-sales.conversation.advance-conversation','crm.website-sales.conversation.stop-conversation','crm.website-sales.enablement.read','crm.website-sales.enablement.propose-next-step','crm.website-sales.enablement.propose-care','crm.website-sales.enablement.prepare-care-offer','crm.website-sales.enablement.scan-hygiene','crm.website-sales.commerce.read','crm.website-sales.commerce.reconcile','crm.website-sales.commerce.prepare-contract','crm.website-sales.commerce.queue-offer-delivery','crm.website-sales.commerce.queue-contract-delivery','crm.website-sales.commerce.request-signature','crm.website-sales.commerce.prepare-invoice-request','crm.website-sales.commerce.propose-renewal','crm.website-sales.commerce.ingest-source'));
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
  and(g.scopes <@ array['crm.website-sales.read','crm.website-sales.studio.read','crm.website-sales.lifecycle.read','crm.website-sales.autonomy.read','crm.website-sales.conversation.read','crm.website-sales.enablement.read','crm.website-sales.commerce.read','crm.website-sales.commerce.reconcile']::text[] or project_grant.can_edit_deals)
  and exists(select 1 from public.projects project join public.organizations company on company.workspace_id=project.workspace_id and company.project_id=project.id
    where project.workspace_id=g.workspace_id and project.id=g.project_id and company.id=g.company_id and project.division='WEB_DESIGN'
     and project.data_classification='NOVALURE_INTERNAL' and project.data_purpose='crm_sales' and company.data_classification='NOVALURE_INTERNAL' and company.data_purpose='crm_sales')
  and(g.location_id is null or exists(select 1 from public.crm_company_locations location where location.workspace_id=g.workspace_id and location.project_id=g.project_id and location.company_id=g.company_id and location.id=g.location_id))
 for share of g,p,source_actor,actor,w,project_grant
$function$;
commit;

-- Reserve immutable schedule slots independently of command UUIDs; a new command cannot invoice twice.
create table crm_website_sales_commerce_invoice_slots(
 workspace_id uuid not null,project_id uuid not null,company_id uuid not null,location_id uuid not null,workflow_id uuid not null,
 contract_id uuid not null,contract_version integer not null,installment_id uuid not null,request_id uuid not null,request_version integer not null,
 primary key(workspace_id,workflow_id,contract_id,contract_version,installment_id),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,contract_id,contract_version) references crm_website_sales_commerce_records(workspace_id,project_id,company_id,location_id,workflow_id,entity_id,version),
 foreign key(workspace_id,project_id,company_id,location_id,workflow_id,request_id,request_version) references crm_website_sales_commerce_records(workspace_id,project_id,company_id,location_id,workflow_id,entity_id,version)
);
alter table crm_website_sales_commerce_invoice_slots enable row level security;alter table crm_website_sales_commerce_invoice_slots force row level security;
create policy commerce_read on crm_website_sales_commerce_invoice_slots for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false));
create policy commerce_insert on crm_website_sales_commerce_invoice_slots for insert to novalure_tenant_app with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));
revoke all on crm_website_sales_commerce_invoice_slots from public;grant select,insert on crm_website_sales_commerce_invoice_slots to novalure_tenant_app;
create trigger commerce_immutable before update or delete or truncate on crm_website_sales_commerce_invoice_slots for each statement execute function crm_reject_immutable_mutation();
-- Only the dedicated exact-resource host executor projects verified closing facts.
grant select on deals,crm_pipeline_stages,deal_stage_history to novalure_website_sales_commerce_executor;
create policy commerce_executor_read on deals for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
create policy commerce_executor_read on crm_pipeline_stages for select to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant update(stage,value_cents,probability,closed_at,lost_at,lost_reason_category,lost_reason_detail,version,updated_at) on deals to novalure_website_sales_commerce_executor;
create policy commerce_executor_update on deals for update to novalure_website_sales_commerce_executor using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant insert on deal_stage_history to novalure_website_sales_commerce_executor;
create policy commerce_executor_append on deal_stage_history for insert to novalure_website_sales_commerce_executor with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant update(follow_up_status,follow_up_at,follow_up_reason,response_reference,response_actor_id) on crm_offers to novalure_website_sales_commerce_executor;
grant select,update(id) on deals to novalure_website_sales_commerce_lock_owner;
create policy commerce_lock_owner on deals for all to novalure_website_sales_commerce_lock_owner using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid) with check(false);
-- Serialize current contact-wide suppressions with the already-held dispatch contact lock.
create function crm_website_sales_commerce_consent_lock() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare ws uuid;cid uuid;email_value text;
begin
 ws:=case when tg_op='DELETE' then old.workspace_id else new.workspace_id end;
 if tg_table_name='consent_records' then
  cid:=case when tg_op='DELETE' then old.contact_id else new.contact_id end;
  perform c.id from contacts c where c.workspace_id=ws and c.id=cid and exists(select 1 from crm_website_sales_workflows w where w.workspace_id=ws and w.contact_id=c.id) for update;
 else
  email_value:=case when tg_op='DELETE' then old.email else new.email end;
  perform c.id from contacts c where c.workspace_id=ws and lower(c.email)=lower(email_value) and exists(select 1 from crm_website_sales_workflows w where w.workspace_id=ws and w.contact_id=c.id) order by c.id for update;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger commerce_consent_linearization before insert or update or delete on consent_records for each row execute function crm_website_sales_commerce_consent_lock();
create trigger commerce_suppression_linearization before insert or update or delete on newsletter_suppressions for each row execute function crm_website_sales_commerce_consent_lock();

-- Match the existing internal Sales classification boundary for direct runtime SQL as well as APIs.
do $$declare relation text;begin
 foreach relation in array array['crm_website_sales_commerce','crm_website_sales_commerce_records','crm_website_sales_commerce_jobs','crm_website_sales_commerce_sources','crm_website_sales_commerce_approvals','crm_website_sales_commerce_allocations'] loop
  execute format('create policy commerce_internal_classification on %I as restrictive for all to novalure_tenant_app,novalure_website_sales_commerce_executor using(data_classification=''NOVALURE_INTERNAL'' and data_purpose=''crm_sales'' and crm_classification_allowed(workspace_id,data_classification,data_purpose)) with check(data_classification=''NOVALURE_INTERNAL'' and data_purpose=''crm_sales'' and crm_classification_allowed(workspace_id,data_classification,data_purpose))',relation);
 end loop;
end $$;
