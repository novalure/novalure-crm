-- D11 contract phase. This file is intentionally outside migrations/*.sql and
-- cannot be selected by the normal migration runner. Apply only after Expand,
-- repeated Backfill, exact-candidate QA and separate owner approval.

set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
declare blockers jsonb;
begin
  select jsonb_strip_nulls(jsonb_build_object(
    'projects',nullif((select count(*) from public.projects where division is null),0),
    'leads',nullif((select count(*) from public.leads where division is null),0),
    'deals',nullif((select count(*) from public.deals where division is null),0),
    'crm_pipelines',nullif((select count(*) from public.crm_pipelines where division is null),0),
    'crm_offers',nullif((select count(*) from public.crm_offers where division is null),0),
    'property_sales',nullif((select count(*) from public.property_sales where division is null),0),
    'crm_conversion_snapshots',nullif((select count(*) from public.crm_conversion_snapshots where division is null),0),
    'pipeline_forecast_snapshots',nullif((select count(*) from public.pipeline_forecast_snapshots where division is null),0),
    'funnel_conversion_reports',nullif((select count(*) from public.funnel_conversion_reports where division is null),0),
    'owner_authority_digest',nullif((select count(*) from public.crm_evelyn_contract_executions where owner_authority_digest is null),0),
    'owner_authority_digest_mismatch',nullif((
      select count(*)
        from public.crm_evelyn_contract_executions execution
        join public.crm_evelyn_contract_revisions revision
          on revision.workspace_id=execution.workspace_id
         and revision.action_id=execution.action_id
         and revision.version=execution.version
       where execution.owner_authority_digest is distinct from public.crm_owner_authority_digest(
         execution.workspace_id,execution.action_id,(revision.action->>'resourceId')::uuid,
         execution.version,revision.action_hash,execution.approval_reference
       )
    ),0),
    'proposal_bindings',nullif((
      select count(*) from public.crm_offer_revisions where not (
        jsonb_typeof(content->'scope')='string' and length(trim(content->>'scope'))>0 and
        jsonb_typeof(content->'paymentPlan')='string' and length(trim(content->>'paymentPlan'))>0 and
        jsonb_typeof(content->'discounts')='string' and length(trim(content->>'discounts'))>0 and
        jsonb_typeof(content->'specialTerms')='string' and length(trim(content->>'specialTerms'))>0 and
        jsonb_typeof(content->'riskComplianceNotes')='string' and length(trim(content->>'riskComplianceNotes'))>0
      )
    ),0)
  )) into blockers;
  if blockers <> '{}'::jsonb then
    raise exception using errcode='23514',message='D11_CONTRACT_PREFLIGHT_FAILED',detail=blockers::text;
  end if;
end $$;

alter table projects alter column division set not null;
alter table leads alter column division set not null;
alter table deals alter column division set not null;
alter table crm_pipelines alter column division set not null;
alter table crm_offers alter column division set not null;
alter table property_sales alter column division set not null;
alter table crm_conversion_snapshots alter column division set not null;
alter table pipeline_forecast_snapshots alter column division set not null;
alter table funnel_conversion_reports alter column division set not null;

alter table crm_evelyn_contract_executions
  validate constraint crm_evelyn_execution_owner_digest_shape;
alter table crm_evelyn_contract_executions
  alter column owner_authority_digest set not null;

alter table crm_offer_revisions
  add constraint crm_offer_exact_approval_payload_check check(
    jsonb_typeof(content->'scope')='string' and length(trim(content->>'scope'))>0 and
    jsonb_typeof(content->'paymentPlan')='string' and length(trim(content->>'paymentPlan'))>0 and
    jsonb_typeof(content->'discounts')='string' and length(trim(content->>'discounts'))>0 and
    jsonb_typeof(content->'specialTerms')='string' and length(trim(content->>'specialTerms'))>0 and
    jsonb_typeof(content->'riskComplianceNotes')='string' and length(trim(content->>'riskComplianceNotes'))>0
  ) not valid;
alter table crm_offer_revisions validate constraint crm_offer_exact_approval_payload_check;

create or replace function crm_bind_project_division() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare canonical public.crm_division;
begin
  if new.project_id is null then
    if new.division is null and tg_table_name <> 'organizations' then
      new.division := 'REAL_ESTATE_GROWTH';
    end if;
    return new;
  end if;
  select division into canonical from public.projects
   where workspace_id=new.workspace_id and id=new.project_id;
  if canonical is null then
    raise exception using errcode='23503',message='CRM_PROJECT_DIVISION_REQUIRED';
  end if;
  if new.division is not null and new.division is distinct from canonical then
    raise exception using errcode='23514',message='CRM_DIVISION_PROJECT_MISMATCH';
  end if;
  new.division := canonical;
  return new;
end $$;

create function crm_project_division_immutable_after_use() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  if new.division is distinct from old.division and (
    exists(select 1 from public.deals where workspace_id=old.workspace_id and project_id=old.id) or
    exists(select 1 from public.crm_pipelines where workspace_id=old.workspace_id and project_id=old.id) or
    exists(select 1 from public.crm_offers where workspace_id=old.workspace_id and project_id=old.id) or
    exists(select 1 from public.property_sales where workspace_id=old.workspace_id and project_id=old.id)
  ) then
    raise exception using errcode='23514',message='CRM_PROJECT_DIVISION_IMMUTABLE_AFTER_COMMERCIAL_USE';
  end if;
  return new;
end $$;
create trigger crm_project_division_immutable before update of division on projects
 for each row execute function crm_project_division_immutable_after_use();

create or replace function crm_offer_configured_approver(p_workspace uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare approver uuid;
begin
  if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
     or not exists(select 1 from public.workspace_users where workspace_id=p_workspace and id=nullif(current_setting('app.actor_id',true),'')::uuid and status='active') then
    raise exception using errcode='42501',message='Invalid approval context';
  end if;
  select u.id into approver
    from public.workspaces w
    join public.workspace_users u on u.workspace_id=w.id
      and u.id::text=w.setup_state->>'salesApprovalUserId'
      and u.status='active' and u.role='owner'
   where w.id=p_workspace for share of w,u;
  return approver;
end $$;
revoke all on function crm_offer_configured_approver(uuid) from public;
grant execute on function crm_offer_configured_approver(uuid) to novalure_tenant_app;

create function crm_require_owner_a3_actor() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  actor uuid;
  expected_digest text;
begin
  if tg_table_name='crm_offer_approvals' then actor := new.actor_id;
  elsif tg_table_name='crm_evelyn_contract_approvals' then actor := new.recorded_by;
  elsif tg_table_name='crm_evelyn_contract_executions' then actor := new.executed_by;
  else actor := null;
  end if;
  if actor is null or not exists(
    select 1 from public.workspace_users
     where workspace_id=new.workspace_id and id=actor and status='active' and role='owner'
  ) then
    raise exception using errcode='42501',message='OWNER_A3_REQUIRED';
  end if;
  if tg_table_name='crm_evelyn_contract_executions' then
    select public.crm_owner_authority_digest(
      new.workspace_id,new.action_id,(revision.action->>'resourceId')::uuid,
      new.version,revision.action_hash,new.approval_reference
    ) into expected_digest
      from public.crm_evelyn_contract_revisions revision
     where revision.workspace_id=new.workspace_id
       and revision.action_id=new.action_id and revision.version=new.version;
    if expected_digest is null or new.owner_authority_digest is distinct from expected_digest then
      raise exception using errcode='23514',message='OWNER_A3_ATTESTATION_REQUIRED';
    end if;
  end if;
  return new;
end $$;
create trigger crm_offer_owner_a3 before insert on crm_offer_approvals
 for each row execute function crm_require_owner_a3_actor();
create trigger crm_contract_approval_owner_a3 before insert on crm_evelyn_contract_approvals
 for each row execute function crm_require_owner_a3_actor();
create trigger crm_contract_execution_owner_a3 before insert on crm_evelyn_contract_executions
 for each row execute function crm_require_owner_a3_actor();

insert into public.crm_d11_migration_audit(phase,updated_counts,remaining_counts)
values('CONTRACT','{"strictConstraints":true,"strictTriggers":true}'::jsonb,'{}'::jsonb);
