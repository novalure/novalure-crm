-- D11 expand phase: additive schema only.
--
-- Deployment order:
--   1. this checksummed migration (old and new applications remain compatible)
--   2. migrations/staged/087_d11_crm_source_of_truth_backfill.sql until clean
--   3. the dual-compatible U1 application
--   4. separately approved migrations/staged/087_d11_crm_source_of_truth_contract.sql
--
-- Production is not migrated by committing this file. The repository migration
-- runner still requires its normal explicit target, plan token and apply step.

do $$ begin
  create type crm_division as enum ('REAL_ESTATE_GROWTH','WEB_DESIGN');
exception when duplicate_object then null;
end $$;

-- Nullable, additive columns keep the currently deployed writer valid.
alter table projects add column division crm_division;
-- The repository's historical CRM baseline is real-estate. This is the one
-- semantically safe compatibility default retained from the original D11
-- migration so old project writers can continue omitting the new column.
alter table projects alter column division set default 'REAL_ESTATE_GROWTH';
alter table organizations add column division crm_division;
alter table leads add column division crm_division;
alter table deals add column division crm_division;
alter table crm_pipelines add column division crm_division;
alter table crm_offers add column division crm_division;
alter table property_sales add column division crm_division;
alter table crm_conversion_snapshots add column division crm_division;
alter table pipeline_forecast_snapshots add column division crm_division;
alter table funnel_conversion_reports add column division crm_division;

alter table crm_evelyn_contract_executions
  add column owner_authority_digest text;
alter table crm_evelyn_contract_executions
  add constraint crm_evelyn_execution_owner_digest_shape
  check(owner_authority_digest is null or owner_authority_digest ~ '^[0-9a-f]{64}$') not valid;

create table crm_d11_migration_audit (
  id bigint generated always as identity primary key,
  phase text not null check(phase in ('BACKFILL','CONTRACT','CONTRACT_ROLLBACK')),
  batch_limit integer,
  updated_counts jsonb not null default '{}'::jsonb,
  remaining_counts jsonb not null default '{}'::jsonb,
  executed_at timestamptz not null default clock_timestamp(),
  executed_by text not null default current_user
);
revoke all on crm_d11_migration_audit from public;

-- Compatibility trigger: old writers may omit division. It only supplies an
-- additive value and rejects an explicit cross-division child. Contract later
-- replaces this function with the strict version without replacing triggers.
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

  select division into canonical
    from public.projects
   where workspace_id=new.workspace_id and id=new.project_id;
  if not found then
    raise exception using errcode='23503',message='CRM_PROJECT_REQUIRED';
  end if;
  if canonical is not null and new.division is not null and new.division is distinct from canonical then
    raise exception using errcode='23514',message='CRM_DIVISION_PROJECT_MISMATCH';
  end if;
  new.division := coalesce(canonical,new.division,'REAL_ESTATE_GROWTH'::public.crm_division);
  return new;
end $$;

do $$ declare relation text; begin
  foreach relation in array array[
    'organizations','leads','deals','crm_pipelines','crm_offers','property_sales',
    'crm_conversion_snapshots','pipeline_forecast_snapshots','funnel_conversion_reports'
  ] loop
    execute format(
      'create trigger crm_project_division_binding before insert or update of workspace_id,project_id,division on %I for each row execute function crm_bind_project_division()',
      relation
    );
  end loop;
end $$;

-- Exact PostgreSQL implementation of Evelyn's canonical owner-A3 digest. It is
-- used for deterministic legacy backfill and later for strict trigger checks.
create function crm_owner_authority_digest(
  p_workspace_id uuid,
  p_action_id uuid,
  p_resource_id uuid,
  p_action_version integer,
  p_action_hash text,
  p_approval_reference uuid
) returns text
language sql immutable strict parallel safe set search_path=pg_catalog,public as $$
  select encode(digest(convert_to(
    '{"actionHash":' || to_jsonb(p_action_hash)::text ||
    ',"actionId":' || to_jsonb(p_action_id::text)::text ||
    ',"actionVersion":' || p_action_version::text ||
    ',"approvalClass":"A3"' ||
    ',"approvalReference":' || to_jsonb(p_approval_reference::text)::text ||
    ',"approverRole":"OWNER"' ||
    ',"contractVersion":"owner-a3-attestation-v1"' ||
    ',"delegated":false' ||
    ',"ownerBound":true' ||
    ',"resourceId":' || to_jsonb(p_resource_id::text)::text ||
    ',"tenantId":' || to_jsonb(p_workspace_id::text)::text || '}',
    'UTF8'
  ),'sha256'),'hex')
$$;
revoke all on function crm_owner_authority_digest(uuid,uuid,uuid,integer,text,uuid) from public;
grant execute on function crm_owner_authority_digest(uuid,uuid,uuid,integer,text,uuid) to novalure_tenant_app;

-- One invocation performs at most p_batch_size updates per relation. Repeated
-- invocations are idempotent and commit independently, so interruption is safe.
create function crm_d11_backfill_batch(p_batch_size integer default 500)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  relation text;
  changed integer;
  updated jsonb := '{}'::jsonb;
  remaining jsonb;
begin
  if p_batch_size < 1 or p_batch_size > 5000 then
    raise exception using errcode='22023',message='D11_BACKFILL_BATCH_LIMIT_INVALID';
  end if;

  with batch as (
    select ctid from public.projects where division is null
     order by workspace_id,id limit p_batch_size for update skip locked
  )
  update public.projects target set division='REAL_ESTATE_GROWTH'
    from batch where target.ctid=batch.ctid;
  get diagnostics changed = row_count;
  updated := jsonb_set(updated,'{projects}',to_jsonb(changed));

  foreach relation in array array[
    'leads','deals','crm_pipelines','crm_offers','property_sales',
    'crm_conversion_snapshots','pipeline_forecast_snapshots','funnel_conversion_reports'
  ] loop
    execute format($sql$
      with batch as (
        select child.ctid,
               coalesce(project.division,'REAL_ESTATE_GROWTH'::public.crm_division) as target_division
          from public.%I child
          left join public.projects project
            on project.workspace_id=child.workspace_id and project.id=child.project_id
         where child.division is null
         order by child.workspace_id,child.id
         limit $1 for update of child skip locked
      )
      update public.%I child set division=batch.target_division
        from batch where child.ctid=batch.ctid
    $sql$,relation,relation) using p_batch_size;
    get diagnostics changed = row_count;
    updated := jsonb_set(updated,array[relation],to_jsonb(changed));
  end loop;

  with batch as (
    select child.ctid,project.division as target_division
      from public.organizations child
      join public.projects project
        on project.workspace_id=child.workspace_id and project.id=child.project_id
     where child.division is null and child.project_id is not null
     order by child.workspace_id,child.id limit p_batch_size
     for update of child skip locked
  )
  update public.organizations child set division=batch.target_division
    from batch where child.ctid=batch.ctid;
  get diagnostics changed = row_count;
  updated := jsonb_set(updated,'{organizations}',to_jsonb(changed));

  -- No authority is invented. A legacy execution is backfilled only when its
  -- durable revision and approval binding are present and its actor is still an
  -- active Owner. Anything else remains null and blocks Contract.
  if exists(select 1 from public.crm_evelyn_contract_executions where owner_authority_digest is null) then
    -- Migration 086 makes this append-only evidence table immutable with a
    -- statement trigger. The table-owner migration transaction takes the DDL
    -- lock, disables only that trigger, fills only the new additive column and
    -- restores the trigger before commit. Any error rolls all four steps back.
    alter table public.crm_evelyn_contract_executions
      disable trigger crm_evelyn_evidence_immutable;
    with batch as (
      select execution.ctid,
             public.crm_owner_authority_digest(
               execution.workspace_id,
               execution.action_id,
               (revision.action->>'resourceId')::uuid,
               execution.version,
               revision.action_hash,
               execution.approval_reference
             ) as digest_value
        from public.crm_evelyn_contract_executions execution
        join public.crm_evelyn_contract_revisions revision
          on revision.workspace_id=execution.workspace_id
         and revision.action_id=execution.action_id
         and revision.version=execution.version
        join public.workspace_users actor
          on actor.workspace_id=execution.workspace_id
         and actor.id=execution.executed_by
         and actor.status='active' and actor.role='owner'
       where execution.owner_authority_digest is null
         and revision.action_hash ~ '^[0-9a-f]{64}$'
         and revision.action->>'resourceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       order by execution.workspace_id,execution.id limit p_batch_size
       for update of execution skip locked
    )
    update public.crm_evelyn_contract_executions execution
       set owner_authority_digest=batch.digest_value
      from batch where execution.ctid=batch.ctid;
    get diagnostics changed = row_count;
    alter table public.crm_evelyn_contract_executions
      enable trigger crm_evelyn_evidence_immutable;
  else
    changed := 0;
  end if;
  updated := jsonb_set(updated,'{owner_authority_digest}',to_jsonb(changed));

  select jsonb_build_object(
    'projects',(select count(*) from public.projects where division is null),
    'organizationsWithProject',(select count(*) from public.organizations where project_id is not null and division is null),
    'leads',(select count(*) from public.leads where division is null),
    'deals',(select count(*) from public.deals where division is null),
    'crm_pipelines',(select count(*) from public.crm_pipelines where division is null),
    'crm_offers',(select count(*) from public.crm_offers where division is null),
    'property_sales',(select count(*) from public.property_sales where division is null),
    'crm_conversion_snapshots',(select count(*) from public.crm_conversion_snapshots where division is null),
    'pipeline_forecast_snapshots',(select count(*) from public.pipeline_forecast_snapshots where division is null),
    'funnel_conversion_reports',(select count(*) from public.funnel_conversion_reports where division is null),
    'ownerAuthorityDigest',(select count(*) from public.crm_evelyn_contract_executions where owner_authority_digest is null),
    'proposalRevisionsRequiringExplicitRevision',(
      select count(*) from public.crm_offer_revisions where not (
        jsonb_typeof(content->'scope')='string' and length(trim(content->>'scope'))>0 and
        jsonb_typeof(content->'paymentPlan')='string' and length(trim(content->>'paymentPlan'))>0 and
        jsonb_typeof(content->'discounts')='string' and length(trim(content->>'discounts'))>0 and
        jsonb_typeof(content->'specialTerms')='string' and length(trim(content->>'specialTerms'))>0 and
        jsonb_typeof(content->'riskComplianceNotes')='string' and length(trim(content->>'riskComplianceNotes'))>0
      )
    )
  ) into remaining;

  insert into public.crm_d11_migration_audit(phase,batch_limit,updated_counts,remaining_counts)
  values('BACKFILL',p_batch_size,updated,remaining);
  return jsonb_build_object('updated',updated,'remaining',remaining);
end $$;
revoke all on function crm_d11_backfill_batch(integer) from public;

comment on table crm_evelyn_contract_actions is
  'Orchestration references and immutable synthetic Preview state only; CRM offers, contacts, companies, deals and lifecycle remain canonical in CRM.';
