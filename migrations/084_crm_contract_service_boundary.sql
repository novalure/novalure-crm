-- Restricted synthetic CRM v1 service authentication. No principal or credential is seeded.
set local lock_timeout = '5s';
set local statement_timeout = '14min';
create table crm_service_principals (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references workspaces(id),
 actor_user_id uuid not null,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 tenant_alias text not null check(tenant_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$'),
 agent_id text not null check(agent_id in ('executive','sales','marketing','buyer','support','finance','engineering','security','legal','qc','procurement','hr','personal')),
 scopes text[] not null check(cardinality(scopes)>0 and scopes <@ array['crm.contacts.read','crm.contacts.write','crm.companies.read','crm.developers.read','crm.projects.read','crm.projects.write','crm.units.read','crm.leads.read','crm.leads.write','crm.qualifications.read','crm.offers.read','crm.offers.prepare','crm.tasks.read','crm.tasks.write','crm.appointments.read','crm.viewings.read','crm.reservations.read','crm.reservations.prepare','crm.sales.read','crm.communications.read','crm.communications.write','crm.approvals.read']::text[]),
 data_context text not null check(data_context='CUSTOMER_TENANT'),
 data_classification text not null check(data_classification in ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
 purpose text not null check(purpose='OPERATIONS'),
 environment text not null default 'simulation' check(environment='simulation'),
 synthetic boolean not null default true check(synthetic),
 expires_at timestamptz not null,
 revoked_at timestamptz,
 unique(workspace_id,id),
 foreign key(workspace_id,actor_user_id) references workspace_users(workspace_id,id)
);
create table crm_service_resource_bindings (
 principal_id uuid not null,
 workspace_id uuid not null,
 resource_alias text not null check(resource_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$'),
 entity text not null check(entity in ('Contact','Company','Developer','Project','Unit','BuyerLead','Qualification','Offer','Task','Appointment','Viewing','Reservation','Sale','Communication','ApprovalReference')),
 source_id uuid not null,
 project_id uuid not null,
 data_context text not null default 'UNCLASSIFIED' check(data_context in ('CUSTOMER_TENANT','NOVALURE_INTERNAL','PRIVATE_FRANZ','UNCLASSIFIED')),
 data_classification text not null default 'UNCLASSIFIED' check(data_classification in ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED','SECRET','UNCLASSIFIED')),
 domain text not null default 'UNCLASSIFIED' check(domain in ('BUSINESS','HR','PERSONAL','SECURITY','TECHNICAL','UNCLASSIFIED')),
 purpose text not null default 'UNCLASSIFIED' check(purpose in ('OPERATIONS','MANAGEMENT','PERSONAL','SECURITY','RECOVERY','UNCLASSIFIED')),
 primary key(principal_id,resource_alias),
 unique(principal_id,entity,source_id),
 foreign key(workspace_id,principal_id) references crm_service_principals(workspace_id,id),
 foreign key(workspace_id,project_id) references projects(workspace_id,id)
);
create table crm_service_audit_bindings (
 principal_id uuid not null,
 workspace_id uuid not null,
 audit_alias text not null check(audit_alias ~ '^sim-[a-z0-9][a-z0-9:_-]{0,100}$'),
 resource_alias text not null,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz not null,
 primary key(principal_id,audit_alias),
 foreign key(workspace_id,principal_id) references crm_service_principals(workspace_id,id),
 foreign key(principal_id,resource_alias) references crm_service_resource_bindings(principal_id,resource_alias)
);
create index crm_service_principal_actor on crm_service_principals(workspace_id,actor_user_id);
create index crm_service_resource_project on crm_service_resource_bindings(workspace_id,project_id);
alter table crm_service_principals enable row level security;
alter table crm_service_principals force row level security;
alter table crm_service_resource_bindings enable row level security;
alter table crm_service_resource_bindings force row level security;
alter table crm_service_audit_bindings enable row level security;
alter table crm_service_audit_bindings force row level security;
revoke all on crm_service_principals,crm_service_resource_bindings,crm_service_audit_bindings from public,novalure_app,novalure_tenant_app;
create policy crm_service_binding_read on crm_service_resource_bindings for select to novalure_tenant_app using(crm_project_access(workspace_id,project_id,false));
create policy crm_service_audit_binding_read on crm_service_audit_bindings for select to novalure_tenant_app using(workspace_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
grant select on crm_service_resource_bindings,crm_service_audit_bindings to novalure_tenant_app;

-- Credential lookup never returns credential material. A second call inside the business
-- transaction holds the principal/member/workspace locks through effect, audit and commit.
create function crm_authenticate_service(p_hash text)
returns table(id uuid,workspace_id uuid,actor_user_id uuid,tenant_alias text,agent_id text,scopes text[],data_context text,data_classification text,purpose text)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_hash !~ '^[a-f0-9]{64}$' then return; end if;
 return query select p.id,p.workspace_id,p.actor_user_id,p.tenant_alias,p.agent_id,p.scopes,p.data_context,p.data_classification,p.purpose
 from public.crm_service_principals p
 join public.workspace_users u on u.id=p.actor_user_id and u.workspace_id=p.workspace_id
 join public.workspaces w on w.id=p.workspace_id
 where p.token_hash=p_hash and p.revoked_at is null and p.expires_at>clock_timestamp()
   and p.synthetic and p.environment='simulation' and p.purpose='OPERATIONS'
   and u.status='active' and u.role='agent' and u.product_role='project_sales_member'
   and w.setup_state->>'syntheticQa'='true'
   and w.operating_model in ('self_service_customer','managed_by_novalure','hybrid')
 for share of p,u,w;
end $$;
revoke all on function crm_authenticate_service(text) from public;
grant execute on function crm_authenticate_service(text) to novalure_tenant_app;

-- Source-owned bindings cannot change their identity: replace by revoking a principal.
create trigger crm_resource_binding_immutable before update or delete or truncate on crm_service_resource_bindings for each statement execute function crm_reject_immutable_mutation();
create trigger crm_audit_binding_immutable before update or delete or truncate on crm_service_audit_bindings for each statement execute function crm_reject_immutable_mutation();

-- Only the v1 communication projection needs these additive classification fields.
-- Existing conversations remain UNCLASSIFIED and are never exported by the contract.
alter table conversations add column if not exists data_classification text not null default 'UNCLASSIFIED';
alter table conversations add column if not exists data_purpose text not null default 'UNCLASSIFIED';
-- The legacy table has no proven agent RLS cutover. Do not grant generic table
-- access: this narrow credential-checked projection is the only service entry.
create function crm_read_contract_conversation(p_hash text,p_workspace uuid,p_project uuid,p_source uuid)
returns table(id uuid,workspace_id uuid,project_id uuid,updated_at timestamptz,data_classification text,data_purpose text,contact_id uuid,lead_id uuid,channel text,direction text,summary text,sentiment text,last_message_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare principal record;
begin
 select * into principal from public.crm_authenticate_service(p_hash);
 if not found or principal.workspace_id<>p_workspace
    or principal.workspace_id is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
    or principal.actor_user_id is distinct from nullif(current_setting('app.actor_id',true),'')::uuid
    or not ('crm.communications.read'=any(principal.scopes))
    or not public.crm_lock_project_access(p_workspace,p_project,false)
    or not exists(select 1 from public.crm_service_resource_bindings b where b.principal_id=principal.id and b.workspace_id=p_workspace and b.project_id=p_project and b.source_id=p_source and b.entity='Communication' and b.data_context=principal.data_context and b.data_classification=principal.data_classification and b.domain='BUSINESS' and b.purpose=principal.purpose) then
   raise exception using errcode='42501',message='Contract communication is not accessible';
 end if;
 return query select c.id,c.workspace_id,c.project_id,c.updated_at,c.data_classification,c.data_purpose,c.contact_id,c.lead_id,c.channel,c.direction,c.summary,c.sentiment,c.last_message_at
 from public.conversations c where c.id=p_source and c.workspace_id=p_workspace and c.project_id=p_project
  and c.data_classification=principal.data_context and c.data_purpose='crm_sales'
  and public.crm_classification_allowed(c.workspace_id,c.data_classification,c.data_purpose);
end $$;
revoke all on function crm_read_contract_conversation(text,uuid,uuid,uuid) from public;
grant execute on function crm_read_contract_conversation(text,uuid,uuid,uuid) to novalure_tenant_app;
