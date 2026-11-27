-- Protected, separately staged Website Sales Ireland qualification schema.
-- No workload, grant, provider or activation seed.
-- Canonical business records remain organizations/contacts/leads/deals/tasks.
set local lock_timeout = '5s';
set local statement_timeout = '14min';

create unique index crm_website_sales_company_project_key on organizations(workspace_id,project_id,id);

create table crm_company_locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null check(workspace_id='8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid),
  project_id uuid not null check(project_id='f7d83c6b-d08d-4d73-b822-1f1c0b4733d2'::uuid),
  company_id uuid not null,
  location_key text not null check(location_key ~ '^[0-9a-f]{64}$'),
  country_code text not null check(country_code='IE'),
  address text not null check(length(address) between 5 and 1000),
  source_url text not null check(length(source_url) between 8 and 2048),
  source_reference text not null check(length(source_reference) between 1 and 2000),
  registration_basis text not null default 'SESSION_ATTESTED' check(registration_basis='SESSION_ATTESTED'),
  registered_by uuid not null,
  version integer not null default 1 check(version=1),
  created_at timestamptz not null default now(),
  unique(workspace_id,project_id,company_id,id),
  unique(workspace_id,company_id,location_key),
  foreign key(workspace_id,project_id,company_id) references organizations(workspace_id,project_id,id),
  foreign key(workspace_id,registered_by) references workspace_users(workspace_id,id)
);

create table crm_website_sales_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  company_id uuid not null,
  location_id uuid not null,
  location_version integer not null check(location_version>0),
  evidence_digest text not null check(evidence_digest ~ '^[0-9a-f]{64}$'),
  prospect jsonb not null check(jsonb_typeof(prospect)='object'),
  observed_at timestamptz not null,
  valid_until timestamptz not null,
  recorded_by uuid not null,
  created_at timestamptz not null default now(),
  unique(workspace_id,id),
  unique(workspace_id,project_id,company_id,location_id,id),
  foreign key(workspace_id,project_id,company_id,location_id) references crm_company_locations(workspace_id,project_id,company_id,id),
  foreign key(workspace_id,recorded_by) references workspace_users(workspace_id,id),
  check(valid_until>observed_at)
);

create table crm_website_sales_workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  company_id uuid not null,
  location_id uuid not null,
  location_version integer not null check(location_version>0),
  observation_id uuid not null,
  version integer not null default 1 check(version>0),
  status text not null default 'OBSERVED' check(status in('OBSERVED','QUALIFIED','STOPPED')),
  contact_id uuid,
  lead_id uuid,
  deal_id uuid,
  next_task_id uuid,
  studio_operation_id uuid,
  stop_reason text check(stop_reason in('REPLY_RECEIVED','OPT_OUT','NO_FIT','STALE_EVIDENCE','UNKNOWN_DELIVERY')),
  stop_source_reference text,
  last_command_id uuid not null,
  last_correlation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,project_id,company_id,location_id),
  foreign key(workspace_id,project_id,company_id,location_id) references crm_company_locations(workspace_id,project_id,company_id,id),
  foreign key(workspace_id,project_id,company_id,location_id,observation_id) references crm_website_sales_observations(workspace_id,project_id,company_id,location_id,id),
  foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
  foreign key(workspace_id,lead_id) references leads(workspace_id,id),
  foreign key(workspace_id,deal_id) references deals(workspace_id,id),
  foreign key(workspace_id,next_task_id) references tasks(workspace_id,id),
  check((status='STOPPED')=(stop_reason is not null and stop_source_reference is not null)),
  check(status<>'QUALIFIED' or (contact_id is not null and lead_id is not null and deal_id is not null
    and next_task_id is not null and studio_operation_id is not null)),
  check((studio_operation_id is null)=(next_task_id is null)),
  unique(workspace_id,studio_operation_id),
  unique(workspace_id,lead_id)
);

do $$ declare relation text; begin
  foreach relation in array array['crm_company_locations','crm_website_sales_observations','crm_website_sales_workflows'] loop
    execute format('alter table %I add column data_classification text not null default ''UNCLASSIFIED'',add column data_purpose text not null default ''crm_sales''',relation);
    execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
    execute format('alter table %I enable row level security',relation);
    execute format('alter table %I force row level security',relation);
    execute format('create policy website_sales_scope on %I for all to novalure_tenant_app using (workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check (workspace_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid and data_classification=''NOVALURE_INTERNAL'' and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))',relation);
    execute format('revoke all on %I from public,novalure_app,novalure_tenant_app',relation);
    execute format('grant select,insert on %I to novalure_tenant_app',relation);
  end loop;
  foreach relation in array array['crm_company_locations','crm_website_sales_observations'] loop
    execute format('create trigger website_sales_immutable before update or delete or truncate on %I for each statement execute function crm_reject_immutable_mutation()',relation);
  end loop;
end $$;
grant update on crm_website_sales_workflows to novalure_tenant_app;

-- The legacy conversations table intentionally has no generic tenant-runtime SELECT.
-- Expose only a stop signal for one already accessible internal contact, never content.
-- row_security=off raises if a future RLS policy would hide a possible reply.
create function crm_website_sales_has_reply(p_workspace uuid,p_project uuid,p_contact uuid,p_since timestamptz)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp set row_security=off as $$
begin
  if p_workspace is distinct from '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'::uuid
    or p_project is distinct from 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2'::uuid
    or p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
    or p_since is null
    or not public.crm_lock_project_access(p_workspace,p_project,false)
    or not public.crm_classification_allowed(p_workspace,'NOVALURE_INTERNAL','crm_sales')
    or not exists(select 1 from public.contacts c where c.workspace_id=p_workspace and c.project_id=p_project and c.id=p_contact
      and c.data_classification='NOVALURE_INTERNAL' and c.data_purpose='crm_sales' and c.archived_at is null)
  then raise exception using errcode='42501',message='Website Sales reply scope denied'; end if;
  return exists(select 1 from public.conversations c where c.workspace_id=p_workspace and c.project_id=p_project and c.contact_id=p_contact
    and lower(c.direction) in('inbound','incoming','eingehend') and c.last_message_at>=p_since);
end $$;
revoke all on function crm_website_sales_has_reply(uuid,uuid,uuid,timestamptz) from public,novalure_app,novalure_tenant_app;
grant execute on function crm_website_sales_has_reply(uuid,uuid,uuid,timestamptz) to novalure_tenant_app;

comment on table crm_company_locations is 'Canonical organization locations attested by an existing authorized internal CRM session; no external verification or outreach authority implied.';
comment on table crm_website_sales_workflows is 'Internal orchestration links to canonical CRM business rows; qualification and internal follow-up only.';
