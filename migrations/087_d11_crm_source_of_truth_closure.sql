-- D11: canonical division binding and Owner-only exact-payload A3 send gates.
-- Existing CRM rows predate the division contract and belong to this real-estate
-- CRM baseline. New security/commercial writes are constrained to the two
-- canonical values and project-scoped children inherit their project's value.
do $$ begin
  create type crm_division as enum ('REAL_ESTATE_GROWTH','WEB_DESIGN');
exception when duplicate_object then null;
end $$;

alter table projects add column division crm_division;
update projects set division='REAL_ESTATE_GROWTH' where division is null;
alter table projects alter column division set default 'REAL_ESTATE_GROWTH';
alter table projects alter column division set not null;

alter table organizations add column division crm_division;
alter table deals add column division crm_division;
alter table crm_pipelines add column division crm_division;
alter table crm_offers add column division crm_division;
alter table property_sales add column division crm_division;
alter table crm_conversion_snapshots add column division crm_division;
alter table pipeline_forecast_snapshots add column division crm_division;
alter table funnel_conversion_reports add column division crm_division;

update organizations child set division=project.division from projects project
 where child.workspace_id=project.workspace_id and child.project_id=project.id and child.division is null;
update deals child set division=coalesce(project.division,'REAL_ESTATE_GROWTH') from projects project
 where child.workspace_id=project.workspace_id and child.project_id=project.id and child.division is null;
update deals set division='REAL_ESTATE_GROWTH' where division is null;
update crm_pipelines child set division=coalesce(project.division,'REAL_ESTATE_GROWTH') from projects project
 where child.workspace_id=project.workspace_id and child.project_id=project.id and child.division is null;
update crm_pipelines set division='REAL_ESTATE_GROWTH' where division is null;
update crm_offers child set division=project.division from projects project
 where child.workspace_id=project.workspace_id and child.project_id=project.id and child.division is null;
update property_sales child set division=project.division from projects project
 where child.workspace_id=project.workspace_id and child.project_id=project.id and child.division is null;
update crm_conversion_snapshots child set division=project.division from projects project
 where child.workspace_id=project.workspace_id and child.project_id=project.id and child.division is null;
update crm_conversion_snapshots set division='REAL_ESTATE_GROWTH' where division is null;
update pipeline_forecast_snapshots child set division=project.division from projects project
 where child.workspace_id=project.workspace_id and child.project_id=project.id and child.division is null;
update pipeline_forecast_snapshots set division='REAL_ESTATE_GROWTH' where division is null;
update funnel_conversion_reports child set division=project.division from projects project
 where child.workspace_id=project.workspace_id and child.project_id=project.id and child.division is null;
update funnel_conversion_reports set division='REAL_ESTATE_GROWTH' where division is null;

alter table deals alter column division set not null;
alter table crm_pipelines alter column division set not null;
alter table crm_offers alter column division set not null;
alter table property_sales alter column division set not null;
alter table crm_conversion_snapshots alter column division set not null;
alter table pipeline_forecast_snapshots alter column division set not null;
alter table funnel_conversion_reports alter column division set not null;

create function crm_bind_project_division() returns trigger
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

do $$ declare relation text; begin
  foreach relation in array array['organizations','deals','crm_pipelines','crm_offers','property_sales','crm_conversion_snapshots','pipeline_forecast_snapshots','funnel_conversion_reports'] loop
    execute format('create trigger crm_project_division_binding before insert or update of workspace_id,project_id,division on %I for each row execute function crm_bind_project_division()',relation);
  end loop;
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

-- Exact external-proposal payload: legacy rows stay readable but cannot create a
-- new revision or pass the application send gate until explicitly revised.
alter table crm_offer_revisions add constraint crm_offer_exact_approval_payload_check check(
  jsonb_typeof(content->'scope')='string' and length(trim(content->>'scope'))>0 and
  jsonb_typeof(content->'paymentPlan')='string' and length(trim(content->>'paymentPlan'))>0 and
  jsonb_typeof(content->'discounts')='string' and length(trim(content->>'discounts'))>0 and
  jsonb_typeof(content->'specialTerms')='string' and length(trim(content->>'specialTerms'))>0 and
  jsonb_typeof(content->'riskComplianceNotes')='string' and length(trim(content->>'riskComplianceNotes'))>0
) not valid;

alter table crm_evelyn_contract_executions add column owner_authority_digest text
 check(owner_authority_digest ~ '^[0-9a-f]{64}$');

-- The configured sales authority is valid only while it is an active Owner.
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
declare actor uuid;
begin
  if tg_table_name='crm_offer_approvals' then
    actor := new.actor_id;
  elsif tg_table_name='crm_evelyn_contract_approvals' then
    actor := new.recorded_by;
  elsif tg_table_name='crm_evelyn_contract_executions' then
    actor := new.executed_by;
  else
    actor := null;
  end if;
  if actor is null or not exists(
    select 1 from public.workspace_users
     where workspace_id=new.workspace_id and id=actor and status='active' and role='owner'
  ) then
    raise exception using errcode='42501',message='OWNER_A3_REQUIRED';
  end if;
  if tg_table_name='crm_evelyn_contract_executions' then
    if new.owner_authority_digest is null then
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

comment on table crm_evelyn_contract_actions is
  'Orchestration references and immutable synthetic Preview state only; CRM offers, contacts, companies, deals and lifecycle remain canonical in CRM.';
