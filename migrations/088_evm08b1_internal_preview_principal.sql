-- EVM-08B.1: allow a disposable read-only principal to address the existing
-- NOVALURE_INTERNAL synthetic QA fixture. Runtime authentication still requires
-- simulation, syntheticQa workspace, active sales agent membership and exact
-- immutable resource/audit bindings. No principal, credential or business data
-- is created by this migration.
alter table crm_service_principals
  drop constraint if exists crm_service_principals_data_context_check;
alter table crm_service_principals
  add constraint crm_service_principals_data_context_check check(
    data_context in ('CUSTOMER_TENANT','NOVALURE_INTERNAL')
  );

comment on constraint crm_service_principals_data_context_check on crm_service_principals is
  'Service principals remain synthetic Preview-only and may bind exact CUSTOMER_TENANT or NOVALURE_INTERNAL QA resources.';

create or replace function crm_authenticate_service(p_hash text)
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
   and u.status='active' and u.role='agent'
   and ((p.data_context='CUSTOMER_TENANT' and u.product_role='project_sales_member'
          and w.operating_model in ('self_service_customer','managed_by_novalure','hybrid'))
     or (p.data_context='NOVALURE_INTERNAL' and w.operating_model='novalure_internal'
          and u.product_role in ('novalureGrowth','novalureServiceOps','novalureAdmin','novalure_sales',
            'novalure_onboarding','novalure_customer_success','novalure_operator')))
   and w.setup_state->>'syntheticQa'='true'
 for share of p,u,w;
end $$;
revoke all on function crm_authenticate_service(text) from public;
grant execute on function crm_authenticate_service(text) to novalure_tenant_app;
