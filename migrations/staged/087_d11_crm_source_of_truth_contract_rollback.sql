-- Data-preserving rollback from D11 Contract to the dual-compatible Expand state.
-- It deliberately keeps columns, enum values, backfilled data and audit rows.
set local lock_timeout='5s';
set local statement_timeout='60s';

drop trigger if exists crm_offer_owner_a3 on crm_offer_approvals;
drop trigger if exists crm_contract_approval_owner_a3 on crm_evelyn_contract_approvals;
drop trigger if exists crm_contract_execution_owner_a3 on crm_evelyn_contract_executions;
drop function if exists crm_require_owner_a3_actor();
drop trigger if exists crm_project_division_immutable on projects;
drop function if exists crm_project_division_immutable_after_use();

alter table crm_offer_revisions drop constraint if exists crm_offer_exact_approval_payload_check;
alter table projects alter column division drop not null;
alter table leads alter column division drop not null;
alter table deals alter column division drop not null;
alter table crm_pipelines alter column division drop not null;
alter table crm_offers alter column division drop not null;
alter table property_sales alter column division drop not null;
alter table crm_conversion_snapshots alter column division drop not null;
alter table pipeline_forecast_snapshots alter column division drop not null;
alter table funnel_conversion_reports alter column division drop not null;
alter table crm_evelyn_contract_executions alter column owner_authority_digest drop not null;

create or replace function crm_bind_project_division() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare canonical public.crm_division;
begin
  if new.project_id is null then
    if new.division is null and tg_table_name <> 'organizations' then new.division := 'REAL_ESTATE_GROWTH'; end if;
    return new;
  end if;
  select division into canonical from public.projects where workspace_id=new.workspace_id and id=new.project_id;
  if not found then raise exception using errcode='23503',message='CRM_PROJECT_REQUIRED'; end if;
  if canonical is not null and new.division is not null and new.division is distinct from canonical then
    raise exception using errcode='23514',message='CRM_DIVISION_PROJECT_MISMATCH';
  end if;
  new.division := coalesce(canonical,new.division,'REAL_ESTATE_GROWTH'::public.crm_division);
  return new;
end $$;

-- Restore the pre-contract approver lookup so the previous compatible app can
-- be rolled back without a schema dependency. The U1 app still enforces Owner.
create or replace function crm_offer_configured_approver(p_workspace uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare approver uuid;
begin
  if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
     or not exists(select 1 from public.workspace_users where workspace_id=p_workspace and id=nullif(current_setting('app.actor_id',true),'')::uuid and status='active') then
    raise exception using errcode='42501',message='Invalid approval context';
  end if;
  select u.id into approver from public.workspaces w join public.workspace_users u
    on u.workspace_id=w.id and u.id::text=w.setup_state->>'salesApprovalUserId' and u.status='active'
   where w.id=p_workspace for share of w,u;
  return approver;
end $$;
revoke all on function crm_offer_configured_approver(uuid) from public;
grant execute on function crm_offer_configured_approver(uuid) to novalure_tenant_app;

insert into public.crm_d11_migration_audit(phase,updated_counts,remaining_counts)
values('CONTRACT_ROLLBACK','{"strictConstraints":false,"strictTriggers":false}'::jsonb,'{}'::jsonb);
