-- EVM-08C: disposable Preview-only synthetic activity proof. No principal,
-- credential or production data is installed by this migration.
alter table crm_service_principals drop constraint if exists crm_service_principals_scopes_check;
alter table crm_service_principals add constraint crm_service_principals_scopes_check check(
 cardinality(scopes)>0 and scopes <@ array[
  'crm.contacts.read','crm.contacts.write','crm.companies.read','crm.developers.read','crm.projects.read',
  'crm.projects.write','crm.units.read','crm.leads.read','crm.leads.write','crm.deals.read','crm.search.read','crm.qualifications.read',
  'crm.offers.read','crm.offers.prepare','crm.tasks.read','crm.tasks.write','crm.appointments.read',
  'crm.viewings.read','crm.reservations.read','crm.reservations.prepare','crm.sales.read',
  'crm.communications.read','crm.communications.write','crm.approvals.read','crm.qa.activity.write'
 ]::text[]
);

create table crm_evm08c_qa_activities (
 id uuid primary key, workspace_id uuid not null, project_id uuid not null, target_entity_id uuid not null,
 principal_id uuid not null, idempotency_key text not null, request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 action_hash text not null check(action_hash~'^[a-f0-9]{64}$'), payload_hash text not null check(payload_hash~'^[a-f0-9]{64}$'),
 content text not null check(content in('SYNTHETIC: EVM-08C controlled QA activity','SYNTHETIC: CLEANED EVM-08C QA activity')),
 synthetic boolean not null default true check(synthetic), environment text not null default 'preview' check(environment='preview'),
 created_at timestamptz not null default clock_timestamp(), cleaned_at timestamptz,
 data_classification text not null default 'NOVALURE_INTERNAL' check(data_classification='NOVALURE_INTERNAL'),
 data_purpose text not null default 'crm_sales' check(data_purpose='crm_sales'),
 unique(workspace_id,idempotency_key), unique(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id),
 foreign key(workspace_id,target_entity_id) references contacts(workspace_id,id),
 foreign key(workspace_id,principal_id) references crm_service_principals(workspace_id,id),
 check((cleaned_at is null and content='SYNTHETIC: EVM-08C controlled QA activity') or
       (cleaned_at is not null and content='SYNTHETIC: CLEANED EVM-08C QA activity'))
);
alter table crm_evm08c_qa_activities enable row level security;
alter table crm_evm08c_qa_activities force row level security;
create policy crm_evm08c_qa_activity_scope on crm_evm08c_qa_activities to novalure_tenant_app
 using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,false))
 with check(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid and crm_project_access(workspace_id,project_id,true));
revoke all on crm_evm08c_qa_activities from public,novalure_app,novalure_tenant_app;
grant select,insert on crm_evm08c_qa_activities to novalure_tenant_app;
grant update(content,cleaned_at) on crm_evm08c_qa_activities to novalure_tenant_app;
comment on table crm_evm08c_qa_activities is 'Disposable, synthetic Preview-only EVM-08C activity evidence; cleanup neutralizes content while retaining the receipt.';
