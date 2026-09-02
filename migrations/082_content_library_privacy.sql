-- Content Library, permission-aware search recents, and privacy lifecycle v1.
--
-- This migration is additive. media_assets remains the binary/file source of truth.
-- Content records only add tenant-qualified, delete-restricting references to it.
-- Retention and erasure are deliberately review proposals; this migration creates
-- no trigger, cron, function, or cascade that permanently deletes business data.

create table crm_safe_mutation_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_user_id uuid not null references workspace_users(id) on delete cascade,
  idempotency_key text not null,
  operation text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response_payload jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, actor_user_id, operation, idempotency_key)
);

create table crm_content_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  title text not null check (length(btrim(title)) between 1 and 240),
  category text not null default 'document' check (length(btrim(category)) between 1 and 80),
  tags text[] not null default '{}',
  visibility text not null default 'internal'
    check (visibility in ('internal', 'customer', 'public')),
  approval_status text not null default 'draft'
    check (approval_status in ('draft', 'needs_review', 'approved', 'rejected')),
  approved_by_user_id uuid references workspace_users(id) on delete set null,
  approved_at timestamptz,
  current_version_number integer not null default 1 check (current_version_number > 0),
  archived_at timestamptz,
  archived_by_user_id uuid references workspace_users(id) on delete set null,
  archive_reason text,
  retention_review_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table crm_content_document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  document_id uuid not null,
  version_number integer not null check (version_number > 0),
  media_asset_id uuid not null,
  media_workspace_id text generated always as (workspace_id::text) stored,
  file_name text not null check (length(btrim(file_name)) between 1 and 255),
  mime_type text not null check (length(btrim(mime_type)) between 1 and 160),
  size_bytes bigint not null check (size_bytes >= 0),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  change_note text not null default '',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, document_id, version_number),
  foreign key (workspace_id, document_id)
    references crm_content_documents(workspace_id, id) on delete restrict,
  foreign key (media_asset_id, media_workspace_id)
    references media_assets(id, workspace_id) on delete restrict
);

create table crm_content_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  document_id uuid not null,
  target_type text not null
    check (target_type in ('contact', 'organization', 'lead', 'project', 'property', 'unit', 'deal', 'closing', 'task')),
  target_id uuid not null,
  project_id uuid references projects(id) on delete set null,
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, document_id, target_type, target_id),
  foreign key (workspace_id, document_id)
    references crm_content_documents(workspace_id, id) on delete restrict
);

create table crm_communication_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  owner_user_id uuid references workspace_users(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 160),
  channel text not null check (channel in ('email', 'sms', 'letter', 'expose', 'note')),
  purpose text not null default 'general' check (length(btrim(purpose)) between 1 and 80),
  default_language text not null default 'de' check (default_language ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
  approval_status text not null default 'draft'
    check (approval_status in ('draft', 'needs_review', 'approved', 'rejected')),
  approved_by_user_id uuid references workspace_users(id) on delete set null,
  approved_at timestamptz,
  current_version_number integer not null default 1 check (current_version_number > 0),
  archived_at timestamptz,
  archived_by_user_id uuid references workspace_users(id) on delete set null,
  archive_reason text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table crm_communication_template_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  template_id uuid not null,
  version_number integer not null check (version_number > 0),
  language text not null check (language ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
  subject text not null default '',
  body text not null,
  allowed_variables text[] not null default '{}',
  variable_fallbacks jsonb not null default '{}',
  structured_content jsonb not null default '{}',
  change_note text not null default '',
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, template_id, version_number),
  foreign key (workspace_id, template_id)
    references crm_communication_templates(workspace_id, id) on delete restrict
);

create table privacy_retention_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type text not null
    check (entity_type in ('contact', 'organization', 'lead', 'project', 'property', 'unit', 'deal', 'task', 'document', 'template')),
  inactivity_days integer not null check (inactivity_days between 1 and 36500),
  proposed_action text not null
    check (proposed_action in ('propose_archive', 'propose_anonymize', 'propose_delete')),
  legal_basis text not null check (length(btrim(legal_basis)) between 1 and 240),
  manual_review_required boolean not null default true check (manual_review_required = true),
  is_active boolean not null default true,
  created_by_user_id uuid references workspace_users(id) on delete set null,
  updated_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, entity_type)
);

create table privacy_retention_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  policy_id uuid references privacy_retention_policies(id) on delete set null,
  entity_type text not null
    check (entity_type in ('contact', 'organization', 'lead', 'project', 'property', 'unit', 'deal', 'task', 'document', 'template')),
  entity_id uuid not null,
  proposed_action text not null
    check (proposed_action in ('propose_archive', 'propose_anonymize', 'propose_delete')),
  rationale text not null check (length(btrim(rationale)) between 1 and 2000),
  status text not null default 'proposed'
    check (status in ('proposed', 'in_review', 'approved_archive', 'approved_anonymize', 'approved_delete', 'rejected', 'completed')),
  legal_hold_blocked boolean not null default false,
  due_at timestamptz,
  reviewed_by_user_id uuid references workspace_users(id) on delete set null,
  reviewed_at timestamptz,
  decision_note text,
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create unique index privacy_retention_reviews_open_target_uidx
  on privacy_retention_reviews(workspace_id, entity_type, entity_id)
  where status in ('proposed', 'in_review');

create table privacy_legal_holds (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type text not null
    check (entity_type in ('workspace', 'contact', 'organization', 'lead', 'project', 'property', 'unit', 'deal', 'task', 'document', 'template')),
  entity_id uuid,
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  reference text not null default '',
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  released_at timestamptz,
  released_by_user_id uuid references workspace_users(id) on delete set null,
  release_note text,
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((entity_type = 'workspace' and entity_id is null) or (entity_type <> 'workspace' and entity_id is not null)),
  check (expires_at is null or expires_at > starts_at),
  unique (workspace_id, id)
);

-- Do not make unreleased rows unique: an expired historical hold must not block
-- a later, non-overlapping hold for the same target. The repository serializes
-- per-target creation and rejects overlapping time ranges transactionally.
create index privacy_legal_holds_target_window_idx
  on privacy_legal_holds(
    workspace_id,
    entity_type,
    coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    starts_at,
    expires_at
  )
  where released_at is null;

create table privacy_data_subject_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  request_reference text not null check (length(btrim(request_reference)) between 1 and 120),
  request_type text not null
    check (request_type in ('access', 'export', 'rectification', 'erasure', 'restriction', 'objection')),
  status text not null default 'received'
    check (status in ('received', 'identity_check', 'in_review', 'approved', 'rejected', 'export_ready', 'completed', 'cancelled')),
  identity_verified_at timestamptz,
  due_at timestamptz,
  export_job_metadata jsonb not null default '{}',
  legal_hold_blocked boolean not null default false,
  review_note text not null default '',
  reviewed_by_user_id uuid references workspace_users(id) on delete set null,
  reviewed_at timestamptz,
  created_by_user_id uuid references workspace_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, request_reference),
  unique (workspace_id, id)
);

-- Scalar foreign keys retain their established ON DELETE behavior. These
-- deferred companion keys additionally prove that every related row belongs to
-- the same tenant; the scalar SET NULL action completes before commit checks.
alter table crm_safe_mutation_requests
  add constraint crm_safe_mutation_requests_workspace_actor_fk
  foreign key (workspace_id, actor_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;
alter table crm_content_documents
  add constraint crm_content_documents_workspace_project_fk
  foreign key (workspace_id, project_id)
  references projects(workspace_id, id) deferrable initially deferred,
  add constraint crm_content_documents_workspace_owner_fk
  foreign key (workspace_id, owner_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred,
  add constraint crm_content_documents_workspace_archived_by_fk
  foreign key (workspace_id, archived_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred,
  add constraint crm_content_documents_workspace_approver_fk
  foreign key (workspace_id, approved_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;
alter table crm_content_document_versions
  add constraint crm_content_document_versions_workspace_creator_fk
  foreign key (workspace_id, created_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;
alter table crm_content_links
  add constraint crm_content_links_workspace_project_fk
  foreign key (workspace_id, project_id)
  references projects(workspace_id, id) deferrable initially deferred,
  add constraint crm_content_links_workspace_creator_fk
  foreign key (workspace_id, created_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;
alter table crm_communication_templates
  add constraint crm_communication_templates_workspace_project_fk
  foreign key (workspace_id, project_id)
  references projects(workspace_id, id) deferrable initially deferred,
  add constraint crm_communication_templates_workspace_owner_fk
  foreign key (workspace_id, owner_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred,
  add constraint crm_communication_templates_workspace_archived_by_fk
  foreign key (workspace_id, archived_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred,
  add constraint crm_communication_templates_workspace_approver_fk
  foreign key (workspace_id, approved_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;
alter table crm_communication_template_versions
  add constraint crm_communication_template_versions_workspace_creator_fk
  foreign key (workspace_id, created_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;

create unique index privacy_retention_policies_workspace_id_uidx
  on privacy_retention_policies(workspace_id, id);
alter table privacy_retention_policies
  add constraint privacy_retention_policies_workspace_creator_fk
  foreign key (workspace_id, created_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred,
  add constraint privacy_retention_policies_workspace_updater_fk
  foreign key (workspace_id, updated_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;
alter table privacy_retention_reviews
  add constraint privacy_retention_reviews_workspace_policy_fk
  foreign key (workspace_id, policy_id)
  references privacy_retention_policies(workspace_id, id) deferrable initially deferred,
  add constraint privacy_retention_reviews_workspace_reviewer_fk
  foreign key (workspace_id, reviewed_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred,
  add constraint privacy_retention_reviews_workspace_creator_fk
  foreign key (workspace_id, created_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;
alter table privacy_legal_holds
  add constraint privacy_legal_holds_workspace_releaser_fk
  foreign key (workspace_id, released_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred,
  add constraint privacy_legal_holds_workspace_creator_fk
  foreign key (workspace_id, created_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;
alter table privacy_data_subject_requests
  add constraint privacy_data_subject_requests_workspace_contact_fk
  foreign key (workspace_id, contact_id)
  references contacts(workspace_id, id) deferrable initially deferred,
  add constraint privacy_data_subject_requests_workspace_reviewer_fk
  foreign key (workspace_id, reviewed_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred,
  add constraint privacy_data_subject_requests_workspace_creator_fk
  foreign key (workspace_id, created_by_user_id)
  references workspace_users(workspace_id, id) deferrable initially deferred;

create index crm_content_documents_workspace_list_idx
  on crm_content_documents(workspace_id, archived_at, updated_at desc, id);
create index crm_content_documents_workspace_project_idx
  on crm_content_documents(workspace_id, project_id, updated_at desc);
create index crm_content_documents_workspace_owner_idx
  on crm_content_documents(workspace_id, owner_user_id, updated_at desc);
create index crm_content_document_versions_document_idx
  on crm_content_document_versions(workspace_id, document_id, version_number desc);
create index crm_content_links_target_idx
  on crm_content_links(workspace_id, target_type, target_id);
create index crm_communication_templates_workspace_list_idx
  on crm_communication_templates(workspace_id, archived_at, updated_at desc, id);
create index privacy_retention_reviews_queue_idx
  on privacy_retention_reviews(workspace_id, status, due_at, created_at);
create index privacy_legal_holds_active_idx
  on privacy_legal_holds(workspace_id, starts_at, expires_at)
  where released_at is null;
create index privacy_data_subject_requests_queue_idx
  on privacy_data_subject_requests(workspace_id, status, due_at, created_at);

create or replace function novalure_reject_immutable_content_version_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Content versions are immutable; create a new version instead'
    using errcode = '55000';
end;
$$;

create trigger crm_content_document_versions_immutable_update
before update on crm_content_document_versions
for each row execute function novalure_reject_immutable_content_version_update();

create trigger crm_communication_template_versions_immutable_update
before update on crm_communication_template_versions
for each row execute function novalure_reject_immutable_content_version_update();

create or replace function novalure_validate_content_link_target()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  target_exists boolean := false;
  target_project_id uuid;
begin
  case new.target_type
    when 'contact' then
      select true, project_id into target_exists, target_project_id
      from contacts where workspace_id = new.workspace_id and id = new.target_id;
    when 'organization' then
      select true, project_id into target_exists, target_project_id
      from organizations where workspace_id = new.workspace_id and id = new.target_id;
    when 'lead' then
      select true, project_id into target_exists, target_project_id
      from leads where workspace_id = new.workspace_id and id = new.target_id;
    when 'project' then
      select true, id into target_exists, target_project_id
      from projects where workspace_id = new.workspace_id and id = new.target_id;
    when 'property' then
      select true, project_id into target_exists, target_project_id
      from seller_listings where workspace_id = new.workspace_id and id = new.target_id;
    when 'unit' then
      select true, project_id into target_exists, target_project_id
      from property_units where workspace_id = new.workspace_id and id = new.target_id;
    when 'deal' then
      select true, project_id into target_exists, target_project_id
      from deals where workspace_id = new.workspace_id and id = new.target_id;
    when 'closing' then
      select true, project_id into target_exists, target_project_id
      from broker_closings where workspace_id = new.workspace_id and id = new.target_id;
    when 'task' then
      select true, project_id into target_exists, target_project_id
      from tasks where workspace_id = new.workspace_id and id = new.target_id;
  end case;

  if coalesce(target_exists, false) = false then
    raise exception 'Content link target does not exist in this workspace'
      using errcode = '23503';
  end if;
  if new.project_id is not null and target_project_id is distinct from new.project_id then
    raise exception 'Content link project does not match its target'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger crm_content_links_validate_target
before insert or update on crm_content_links
for each row execute function novalure_validate_content_link_target();

create or replace function novalure_validate_privacy_policy_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (
    old.entity_type is distinct from new.entity_type
    or old.proposed_action is distinct from new.proposed_action
    or (old.is_active and not new.is_active)
  ) and exists (
    select 1 from privacy_retention_reviews review
     where review.workspace_id = old.workspace_id
       and review.policy_id = old.id
       and review.status in ('proposed', 'in_review')
  ) then
    raise exception 'Open reviews must be resolved before their retention policy changes'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger privacy_retention_policies_guard_open_reviews
before update of entity_type, proposed_action, is_active on privacy_retention_policies
for each row execute function novalure_validate_privacy_policy_update();

create or replace function novalure_validate_retention_review_state()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  linked_policy privacy_retention_policies%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.policy_id is not null then
      select * into linked_policy
        from privacy_retention_policies policy
       where policy.workspace_id = new.workspace_id and policy.id = new.policy_id;
      if not found then
        raise exception 'Retention policy does not exist in this workspace'
          using errcode = '23503';
      end if;
      if not linked_policy.is_active
         or linked_policy.entity_type is distinct from new.entity_type
         or linked_policy.proposed_action is distinct from new.proposed_action then
        raise exception 'Retention policy, entity type, and proposed action must match'
          using errcode = '23514';
      end if;
    end if;
    if new.status <> 'proposed' then
      raise exception 'A retention review must start in proposed status'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.workspace_id is distinct from new.workspace_id
     or old.entity_type is distinct from new.entity_type
     or old.entity_id is distinct from new.entity_id
     or old.policy_id is distinct from new.policy_id
     or old.proposed_action is distinct from new.proposed_action then
    raise exception 'Retention review target, policy, and proposed action are immutable'
      using errcode = '23514';
  end if;

  if old.status is distinct from new.status then
    if new.status = 'completed' then
      raise exception 'Completion requires a separate operation and immutable evidence'
        using errcode = '55000';
    end if;
    if not (
      (old.status = 'proposed' and new.status in ('in_review', 'rejected'))
      or (old.status = 'in_review' and new.status in (
        'approved_archive', 'approved_anonymize', 'approved_delete', 'rejected'
      ))
    ) then
      raise exception 'Invalid retention review status transition from % to %', old.status, new.status
        using errcode = '23514';
    end if;
    if (new.proposed_action = 'propose_archive' and new.status like 'approved_%' and new.status <> 'approved_archive')
       or (new.proposed_action = 'propose_anonymize' and new.status like 'approved_%' and new.status <> 'approved_anonymize')
       or (new.proposed_action = 'propose_delete' and new.status like 'approved_%' and new.status <> 'approved_delete') then
      raise exception 'Retention approval does not match the proposed action'
        using errcode = '23514';
    end if;
    if new.reviewed_by_user_id is null or new.reviewed_at is null
       or nullif(btrim(new.decision_note), '') is null then
      raise exception 'Retention decisions require reviewer, timestamp, and decision note'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger privacy_retention_reviews_validate_state
before insert or update on privacy_retention_reviews
for each row execute function novalure_validate_retention_review_state();

create or replace function novalure_validate_dsar_state()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'received' or new.identity_verified_at is not null
       or new.export_job_metadata <> '{}'::jsonb then
      raise exception 'A data-subject request must start received without operation evidence'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.workspace_id is distinct from new.workspace_id
     or old.contact_id is distinct from new.contact_id
     or old.request_reference is distinct from new.request_reference
     or old.request_type is distinct from new.request_type then
    raise exception 'Data-subject request identity and type are immutable'
      using errcode = '23514';
  end if;
  if old.identity_verified_at is not null
     and old.identity_verified_at is distinct from new.identity_verified_at then
    raise exception 'Identity verification evidence is immutable'
      using errcode = '23514';
  end if;
  if old.identity_verified_at is null and new.identity_verified_at is not null
     and not (old.status = 'identity_check' and new.status = 'in_review') then
    raise exception 'Identity verification may only be recorded when identity check advances to review'
      using errcode = '23514';
  end if;
  if old.export_job_metadata is distinct from new.export_job_metadata then
    raise exception 'Operation evidence requires the dedicated host-side execution path'
      using errcode = '55000';
  end if;

  if old.status is distinct from new.status then
    if new.status in ('export_ready', 'completed') then
      raise exception 'This status requires a separate operation and immutable evidence'
        using errcode = '55000';
    end if;
    if not (
      (old.status = 'received' and new.status in ('identity_check', 'cancelled'))
      or (old.status = 'identity_check' and new.status in ('in_review', 'rejected', 'cancelled'))
      or (old.status = 'in_review' and new.status in ('approved', 'rejected', 'cancelled'))
    ) then
      raise exception 'Invalid data-subject request status transition from % to %', old.status, new.status
        using errcode = '23514';
    end if;
    if new.reviewed_by_user_id is null or new.reviewed_at is null then
      raise exception 'Data-subject request transitions require reviewer evidence'
        using errcode = '23514';
    end if;
  end if;
  if new.status in ('in_review', 'approved', 'export_ready', 'completed')
     and new.identity_verified_at is null then
    raise exception 'Identity verification is required for this status'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger privacy_data_subject_requests_validate_state
before insert or update on privacy_data_subject_requests
for each row execute function novalure_validate_dsar_state();

create or replace function novalure_validate_legal_hold_window()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    new.workspace_id::text || ':' || new.entity_type || ':' || coalesce(new.entity_id::text, 'workspace'),
    0
  ));
  if new.released_at is null and exists (
    select 1 from privacy_legal_holds hold
     where hold.workspace_id = new.workspace_id
       and hold.entity_type = new.entity_type
       and hold.entity_id is not distinct from new.entity_id
       and hold.id <> new.id
       and hold.released_at is null
       and tstzrange(hold.starts_at, hold.expires_at, '[)')
         && tstzrange(new.starts_at, new.expires_at, '[)')
  ) then
    raise exception 'Overlapping unreleased legal hold for this target'
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

create trigger privacy_legal_holds_validate_window
before insert or update of workspace_id, entity_type, entity_id, starts_at, expires_at, released_at
on privacy_legal_holds
for each row execute function novalure_validate_legal_hold_window();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'crm_safe_mutation_requests',
    'crm_content_documents',
    'crm_content_document_versions',
    'crm_content_links',
    'crm_communication_templates',
    'crm_communication_template_versions',
    'privacy_retention_policies',
    'privacy_retention_reviews',
    'privacy_legal_holds',
    'privacy_data_subject_requests'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I for all using (workspace_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid and nullif(current_setting(''app.actor_id'', true), '''')::uuid is not null) with check (workspace_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid and nullif(current_setting(''app.actor_id'', true), '''')::uuid is not null)',
      table_name || '_tenant_policy',
      table_name
    );
  end loop;
end;
$$;

drop policy crm_safe_mutation_requests_tenant_policy on crm_safe_mutation_requests;
create policy crm_safe_mutation_requests_tenant_policy on crm_safe_mutation_requests
for all
using (
  workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
)
with check (
  workspace_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  and actor_user_id = nullif(current_setting('app.actor_id', true), '')::uuid
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'novalure_app') then
    grant select, insert, update on table
      crm_safe_mutation_requests,
      crm_content_documents,
      crm_content_document_versions,
      crm_content_links,
      crm_communication_templates,
      crm_communication_template_versions,
      privacy_retention_policies,
      privacy_retention_reviews,
      privacy_legal_holds,
      privacy_data_subject_requests
    to novalure_app;
  end if;
  if exists (select 1 from pg_roles where rolname = 'novalure_tenant_app') then
    grant select, insert, update on table
      crm_safe_mutation_requests,
      crm_content_documents,
      crm_content_document_versions,
      crm_content_links,
      crm_communication_templates,
      crm_communication_template_versions,
      privacy_retention_policies,
      privacy_retention_reviews,
      privacy_legal_holds,
      privacy_data_subject_requests
    to novalure_tenant_app;
  end if;
end;
$$;
