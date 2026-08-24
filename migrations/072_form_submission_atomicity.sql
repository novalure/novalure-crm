-- Crash-safe public Form submission graph and tenant-qualified relationships.
-- No historical rows are silently repaired: any cross-tenant relation blocks
-- validation and requires an explicit audited remediation decision.

set local lock_timeout = '5s';
set local statement_timeout = '14min';

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute
    where attrelid = 'public.public_submission_idempotency'::regclass
      and attname = 'lease_version'
      and not attisdropped
  ) then
    raise exception 'migration 070_funnel_submission_idempotency_recovery is required before 072';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.forms'::regclass
      and conname = 'forms_workspace_owner_fk'
  ) then
    raise exception 'migration 071_forms_owner_tenant_guard is required before 072';
  end if;
end;
$migration$;

alter table public.form_submissions
  add column if not exists idempotency_key text,
  add column if not exists request_hash text,
  add column if not exists response_payload jsonb,
  add column if not exists claim_lease_version bigint;

alter table public.form_submissions
  drop constraint if exists form_submissions_atomic_idempotency_check;

alter table public.form_submissions
  add constraint form_submissions_atomic_idempotency_check
  check (
    (
      idempotency_key is null
      and request_hash is null
      and response_payload is null
      and claim_lease_version is null
    )
    or coalesce((
      idempotency_key is not null
      and idempotency_key ~ '^form:[a-f0-9]{64}$'
      and request_hash is not null
      and request_hash ~ '^[a-f0-9]{64}$'
      and claim_lease_version is not null
      and claim_lease_version > 0
      and response_payload is not null
      and jsonb_typeof(response_payload) = 'object'
      and (
        (
          response_payload->>'kind' = 'json'
          and jsonb_typeof(response_payload->'body') = 'object'
          and response_payload->>'status' ~ '^[1-5][0-9]{2}$'
        )
        or (
          response_payload->>'kind' = 'redirect'
          and response_payload->>'status' = '303'
          and length(response_payload->>'location') > 0
        )
      )
    ), false)
  );

create unique index if not exists form_submissions_workspace_idempotency_key_uidx
  on public.form_submissions(workspace_id, idempotency_key)
  where idempotency_key is not null;

-- UUID primary keys are globally unique, but composite keys make the tenant
-- relationship enforceable by PostgreSQL rather than application convention.
create unique index if not exists projects_workspace_id_id_uidx
  on public.projects(workspace_id, id);
create unique index if not exists forms_workspace_id_id_uidx
  on public.forms(workspace_id, id);
create unique index if not exists funnels_workspace_id_id_uidx
  on public.funnels(workspace_id, id);
create unique index if not exists contacts_workspace_id_id_uidx
  on public.contacts(workspace_id, id);
create unique index if not exists leads_workspace_id_id_uidx
  on public.leads(workspace_id, id);
create unique index if not exists deals_workspace_id_id_uidx
  on public.deals(workspace_id, id);
create unique index if not exists tasks_workspace_id_id_uidx
  on public.tasks(workspace_id, id);

create index if not exists forms_workspace_project_guard_idx
  on public.forms(workspace_id, project_id);
create index if not exists forms_workspace_funnel_guard_idx
  on public.forms(workspace_id, funnel_id);
create index if not exists form_submissions_workspace_project_guard_idx
  on public.form_submissions(workspace_id, project_id);
create index if not exists form_submissions_workspace_form_guard_idx
  on public.form_submissions(workspace_id, form_id);
create index if not exists form_submissions_workspace_funnel_guard_idx
  on public.form_submissions(workspace_id, funnel_id);
create index if not exists form_submissions_workspace_contact_guard_idx
  on public.form_submissions(workspace_id, contact_id);
create index if not exists form_submissions_workspace_lead_guard_idx
  on public.form_submissions(workspace_id, lead_id);
create index if not exists form_submissions_workspace_deal_guard_idx
  on public.form_submissions(workspace_id, deal_id);
create index if not exists form_submissions_workspace_task_guard_idx
  on public.form_submissions(workspace_id, task_id);

do $migration$
declare
  tenant_fk record;
begin
  for tenant_fk in
    select *
    from (values
      ('forms', 'forms_workspace_project_fk',
        'foreign key (workspace_id, project_id) references public.projects(workspace_id, id) deferrable initially deferred not valid'),
      ('forms', 'forms_workspace_funnel_fk',
        'foreign key (workspace_id, funnel_id) references public.funnels(workspace_id, id) deferrable initially deferred not valid'),
      ('form_submissions', 'form_submissions_workspace_project_fk',
        'foreign key (workspace_id, project_id) references public.projects(workspace_id, id) deferrable initially deferred not valid'),
      ('form_submissions', 'form_submissions_workspace_form_fk',
        'foreign key (workspace_id, form_id) references public.forms(workspace_id, id) deferrable initially deferred not valid'),
      ('form_submissions', 'form_submissions_workspace_funnel_fk',
        'foreign key (workspace_id, funnel_id) references public.funnels(workspace_id, id) deferrable initially deferred not valid'),
      ('form_submissions', 'form_submissions_workspace_contact_fk',
        'foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) deferrable initially deferred not valid'),
      ('form_submissions', 'form_submissions_workspace_lead_fk',
        'foreign key (workspace_id, lead_id) references public.leads(workspace_id, id) deferrable initially deferred not valid'),
      ('form_submissions', 'form_submissions_workspace_deal_fk',
        'foreign key (workspace_id, deal_id) references public.deals(workspace_id, id) deferrable initially deferred not valid'),
      ('form_submissions', 'form_submissions_workspace_task_fk',
        'foreign key (workspace_id, task_id) references public.tasks(workspace_id, id) deferrable initially deferred not valid')
    ) as definitions(table_name, constraint_name, definition)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint
      where conname = tenant_fk.constraint_name
        and conrelid = ('public.' || tenant_fk.table_name)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I %s',
        tenant_fk.table_name,
        tenant_fk.constraint_name,
        tenant_fk.definition
      );
    end if;
  end loop;
end;
$migration$;

alter table public.forms validate constraint forms_workspace_project_fk;
alter table public.forms validate constraint forms_workspace_funnel_fk;
alter table public.form_submissions validate constraint form_submissions_workspace_project_fk;
alter table public.form_submissions validate constraint form_submissions_workspace_form_fk;
alter table public.form_submissions validate constraint form_submissions_workspace_funnel_fk;
alter table public.form_submissions validate constraint form_submissions_workspace_contact_fk;
alter table public.form_submissions validate constraint form_submissions_workspace_lead_fk;
alter table public.form_submissions validate constraint form_submissions_workspace_deal_fk;
alter table public.form_submissions validate constraint form_submissions_workspace_task_fk;
