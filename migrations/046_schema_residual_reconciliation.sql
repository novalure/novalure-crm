alter table workspace_users
  add column if not exists onboarding_current_step text,
  add column if not exists onboarding_completed_steps text[] not null default '{}',
  add column if not exists onboarding_skipped_steps text[] not null default '{}',
  add column if not exists onboarding_dismissed_at timestamptz,
  add column if not exists onboarding_role_context text;

create index if not exists workspace_users_onboarding_progress_idx
  on workspace_users(workspace_id, onboarding_current_step, onboarding_dismissed_at);

create index if not exists deals_workspace_project_closed_idx
  on deals(workspace_id, project_id, closed_at desc);

create index if not exists deals_lost_reason_idx
  on deals(workspace_id, project_id, lost_reason_category)
  where lost_reason_category is not null;

create index if not exists audit_logs_project_deal_created_idx
  on audit_logs(workspace_id, project_id, deal_id, created_at desc);

create index if not exists analytics_events_workspace_project_time_idx
  on analytics_events(workspace_id, project_id, occurred_at desc);

create index if not exists analytics_events_workspace_module_time_idx
  on analytics_events(workspace_id, module, occurred_at desc);

create index if not exists analytics_events_workspace_source_time_idx
  on analytics_events(workspace_id, source, occurred_at desc);

create index if not exists analytics_events_workspace_entity_idx
  on analytics_events(workspace_id, entity_type, entity_id, occurred_at desc);

create index if not exists analytics_events_metadata_gin_idx
  on analytics_events using gin(metadata);

create index if not exists workspaces_operating_model_idx
  on workspaces(operating_model, customer_type);

create index if not exists workspace_users_product_role_idx
  on workspace_users(workspace_id, product_role);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspaces_operating_model_check'
      and conrelid = 'workspaces'::regclass
  ) then
    alter table workspaces
      add constraint workspaces_operating_model_check
      check (operating_model in ('self_service_customer', 'managed_by_novalure', 'hybrid', 'novalure_internal'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspaces_customer_type_check'
      and conrelid = 'workspaces'::regclass
  ) then
    alter table workspaces
      add constraint workspaces_customer_type_check
      check (customer_type in ('real_estate_broker', 'property_developer', 'hybrid_real_estate', 'novalure_internal'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspaces_team_structure_check'
      and conrelid = 'workspaces'::regclass
  ) then
    alter table workspaces
      add constraint workspaces_team_structure_check
      check (team_structure in ('no_sales_team', 'small_team', 'project_sales_available', 'backoffice_available'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workspaces_active_calendar_provider_check'
      and conrelid = 'workspaces'::regclass
  ) then
    alter table workspaces
      add constraint workspaces_active_calendar_provider_check
      check (active_calendar_provider in ('microsoft', 'google', 'none'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_customer_type_check'
      and conrelid = 'projects'::regclass
  ) then
    alter table projects
      add constraint projects_customer_type_check
      check (
        customer_type is null or customer_type in (
          'real_estate_broker',
          'property_developer',
          'hybrid_real_estate',
          'novalure_internal'
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_default_operating_model_check'
      and conrelid = 'projects'::regclass
  ) then
    alter table projects
      add constraint projects_default_operating_model_check
      check (
        default_operating_model is null or default_operating_model in (
          'self_service_customer',
          'managed_by_novalure',
          'hybrid',
          'novalure_internal'
        )
      );
  end if;
end $$;
