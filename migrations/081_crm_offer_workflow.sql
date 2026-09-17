-- Canonical CRM offer records. No provider, credentials or production activation.
-- Requires 080 command/RLS foundation. Existing rows are not reclassified.
create unique index if not exists crm_offer_deals_workspace_id_uidx on deals(workspace_id,id);
create unique index if not exists crm_offer_contacts_workspace_id_uidx on contacts(workspace_id,id);
create unique index if not exists crm_offer_leads_workspace_id_uidx on leads(workspace_id,id);
create unique index if not exists crm_offer_organizations_workspace_id_uidx on organizations(workspace_id,id);
create unique index if not exists crm_offer_users_workspace_id_uidx on workspace_users(workspace_id,id);

create table if not exists crm_offers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  project_id uuid not null,
  deal_id uuid not null,
  contact_id uuid not null,
  lead_id uuid not null,
  organization_id uuid not null,
  status text not null default 'DRAFT' check(status in ('DRAFT','APPROVED','QUEUED','SENT','ACCEPTED','REJECTED','CANCELLED')),
  revision integer not null default 1 check(revision > 0),
  version integer not null default 1 check(version > 0),
  approval_id uuid,
  follow_up_status text not null default 'NONE' check(follow_up_status in ('NONE','SCHEDULED','COMPLETED','STOPPED')),
  follow_up_at timestamptz,
  follow_up_reason text,
  response_reference text,
  response_actor_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,id),
  unique(workspace_id,project_id,id),
  unique(workspace_id,deal_id),
  foreign key(workspace_id,project_id) references projects(workspace_id,id),
  foreign key(workspace_id,deal_id) references deals(workspace_id,id),
  foreign key(workspace_id,contact_id) references contacts(workspace_id,id),
  foreign key(workspace_id,lead_id) references leads(workspace_id,id),
  foreign key(workspace_id,organization_id) references organizations(workspace_id,id),
  foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
  foreign key(workspace_id,response_actor_id) references workspace_users(workspace_id,id),
  check ((follow_up_status = 'SCHEDULED' and follow_up_at is not null) or follow_up_status <> 'SCHEDULED'),
  check (status not in ('ACCEPTED','REJECTED') or (response_reference is not null and response_actor_id is not null and follow_up_status = 'STOPPED'))
);
create table if not exists crm_offer_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  offer_id uuid not null,
  revision integer not null check(revision > 0),
  content jsonb not null check(jsonb_typeof(content) = 'object' and content->>'currency' = 'EUR' and content->>'taxBasis' = 'NET' and jsonb_typeof(content->'items') = 'array' and jsonb_array_length(content->'items') > 0),
  content_digest text not null check(content_digest ~ '^[0-9a-f]{64}$'),
  total_net_cents bigint not null check(total_net_cents > 0 and total_net_cents <= 9007199254740991),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique(workspace_id,offer_id,revision),
  unique(workspace_id,project_id,offer_id,revision),
  unique(workspace_id,offer_id,revision,content_digest),
  foreign key(workspace_id,project_id,offer_id) references crm_offers(workspace_id,project_id,id),
  foreign key(workspace_id,project_id) references projects(workspace_id,id),
  foreign key(workspace_id,created_by) references workspace_users(workspace_id,id)
);
create table if not exists crm_offer_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  offer_id uuid not null,
  revision integer not null,
  content_digest text not null check(content_digest ~ '^[0-9a-f]{64}$'),
  action text not null default 'offer.send' check(action = 'offer.send'),
  actor_id uuid not null,
  auth_session_reference uuid not null references auth_sessions(id),
  decision text not null check(decision in ('APPROVED','REVOKED')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(workspace_id,id),
  foreign key(workspace_id,project_id,offer_id,revision) references crm_offer_revisions(workspace_id,project_id,offer_id,revision),
  foreign key(workspace_id,offer_id,revision,content_digest) references crm_offer_revisions(workspace_id,offer_id,revision,content_digest),
  foreign key(workspace_id,project_id) references projects(workspace_id,id),
  foreign key(workspace_id,actor_id) references workspace_users(workspace_id,id),
  check(expires_at > created_at or decision = 'REVOKED')
);
alter table crm_offers add constraint crm_offers_approval_fk foreign key(workspace_id,approval_id) references crm_offer_approvals(workspace_id,id);
create table if not exists crm_offer_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id uuid not null,
  offer_id uuid not null,
  revision integer not null,
  content_digest text not null check(content_digest ~ '^[0-9a-f]{64}$'),
  recipient_email text not null,
  approval_id uuid not null,
  status text not null default 'QUEUED' check(status in ('QUEUED','MANUALLY_ATTESTED','UNKNOWN','CANCELLED')),
  receipt_reference text,
  attested_by uuid,
  attested_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique(workspace_id,offer_id,revision),
  unique(workspace_id,project_id,offer_id,revision),
  unique(workspace_id,offer_id,revision,content_digest),
  foreign key(workspace_id,project_id,offer_id,revision) references crm_offer_revisions(workspace_id,project_id,offer_id,revision),
  foreign key(workspace_id,offer_id,revision,content_digest) references crm_offer_revisions(workspace_id,offer_id,revision,content_digest),
  foreign key(workspace_id,approval_id) references crm_offer_approvals(workspace_id,id),
  foreign key(workspace_id,project_id) references projects(workspace_id,id),
  foreign key(workspace_id,created_by) references workspace_users(workspace_id,id),
  foreign key(workspace_id,attested_by) references workspace_users(workspace_id,id),
  check(status <> 'MANUALLY_ATTESTED' or (receipt_reference is not null and attested_by is not null and attested_at is not null))
);

create or replace function crm_offer_immutable() returns trigger language plpgsql as $$
begin raise exception 'CRM_OFFER_IMMUTABLE_EVIDENCE'; end $$;
create trigger crm_offer_revisions_immutable before update or delete on crm_offer_revisions for each row execute function crm_offer_immutable();
create trigger crm_offer_approvals_immutable before update or delete on crm_offer_approvals for each row execute function crm_offer_immutable();

-- A direct legacy update cannot contradict an already managed offer outcome or its parties.
create or replace function crm_offer_deal_guard() returns trigger language plpgsql as $$
declare managed crm_offers%rowtype;
begin
  select * into managed from crm_offers where workspace_id = new.workspace_id and deal_id = new.id;
  if found then
    if new.contact_id is distinct from managed.contact_id or new.organization_id is distinct from managed.organization_id or new.lead_id is distinct from managed.lead_id or new.project_id is distinct from managed.project_id then
      raise exception 'CRM_OFFER_PARTIES_IMMUTABLE';
    end if;
    if new.stage = 'Gewonnen' and managed.status <> 'ACCEPTED' then raise exception 'CRM_OFFER_ACCEPTANCE_REQUIRED'; end if;
    if new.stage in ('Verloren','Disqualifiziert','Pausiert / Verloren') and managed.status <> 'REJECTED' then raise exception 'CRM_OFFER_RESPONSE_REQUIRED'; end if;
    if managed.status = 'ACCEPTED' and new.stage <> 'Gewonnen' then raise exception 'CRM_OFFER_OUTCOME_IMMUTABLE'; end if;
    if managed.status = 'REJECTED' and new.stage <> 'Verloren' then raise exception 'CRM_OFFER_OUTCOME_IMMUTABLE'; end if;
  end if;
  return new;
end $$;
create trigger crm_offer_deal_guard before update on deals for each row execute function crm_offer_deal_guard();

do $$
declare relation text;
begin
  foreach relation in array array['crm_offers','crm_offer_revisions','crm_offer_approvals','crm_offer_deliveries'] loop
    execute format('alter table %I add column data_classification text not null default ''UNCLASSIFIED'', add column data_purpose text not null default ''crm_sales''', relation);
    execute format('create trigger crm_sales_classification_guard before insert or update on %I for each row execute function crm_set_sales_classification()',relation);
    execute format('alter table %I enable row level security', relation);
    execute format('alter table %I force row level security', relation);
    execute format('create policy crm_offer_tenant_scope on %I for all to novalure_tenant_app using (workspace_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,false)) with check (workspace_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid and crm_classification_allowed(workspace_id,data_classification,data_purpose) and crm_project_access(workspace_id,project_id,true))', relation);
    execute format('grant select, insert on %I to novalure_tenant_app', relation);
  end loop;
end $$;
grant update on crm_offers, crm_offer_deliveries to novalure_tenant_app;

-- Locks only the configured authority. No generic user/workspace write grant is needed.
create or replace function crm_offer_configured_approver(p_workspace uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare approver uuid;
begin
  if p_workspace is distinct from nullif(current_setting('app.tenant_id',true),'')::uuid
     or not exists(select 1 from public.workspace_users where workspace_id=p_workspace and id=nullif(current_setting('app.actor_id',true),'')::uuid and status='active') then
    raise exception using errcode='42501',message='Invalid approval context';
  end if;
  select u.id into approver from public.workspaces w join public.workspace_users u on u.workspace_id=w.id and u.id::text=w.setup_state->>'salesApprovalUserId' and u.status='active'
  where w.id=p_workspace for share of w,u;
  return approver;
end $$;
revoke all on function crm_offer_configured_approver(uuid) from public;
grant execute on function crm_offer_configured_approver(uuid) to novalure_tenant_app;
