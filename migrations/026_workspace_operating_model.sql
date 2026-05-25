alter table workspaces
  add column if not exists operating_model text not null default 'self_service_customer',
  add column if not exists customer_type text not null default 'real_estate_broker',
  add column if not exists team_structure text not null default 'small_team',
  add column if not exists active_calendar_provider text not null default 'none',
  add column if not exists setup_state jsonb not null default '{}';

alter table workspaces drop constraint if exists workspaces_operating_model_check;
alter table workspaces
  add constraint workspaces_operating_model_check
  check (operating_model in ('self_service_customer', 'managed_by_novalure', 'hybrid', 'novalure_internal'));

alter table workspaces drop constraint if exists workspaces_customer_type_check;
alter table workspaces
  add constraint workspaces_customer_type_check
  check (customer_type in ('real_estate_broker', 'property_developer', 'hybrid_real_estate', 'novalure_internal'));

alter table workspaces drop constraint if exists workspaces_team_structure_check;
alter table workspaces
  add constraint workspaces_team_structure_check
  check (team_structure in ('no_sales_team', 'small_team', 'project_sales_available', 'backoffice_available'));

alter table workspaces drop constraint if exists workspaces_active_calendar_provider_check;
alter table workspaces
  add constraint workspaces_active_calendar_provider_check
  check (active_calendar_provider in ('microsoft', 'google', 'none'));

alter table workspace_users
  add column if not exists product_role text;

alter table workspace_users drop constraint if exists workspace_users_product_role_check;
alter table workspace_users
  add constraint workspace_users_product_role_check
  check (
    product_role is null or product_role in (
      'platform_admin',
      'novalure_sales',
      'novalure_onboarding',
      'novalure_customer_success',
      'novalure_operator',
      'customer_owner',
      'workspace_admin',
      'team_member',
      'broker_agent',
      'developer_sales',
      'project_sales_member',
      'assistant_backoffice',
      'external_partner',
      'viewer'
    )
  );

alter table projects
  add column if not exists customer_type text,
  add column if not exists default_operating_model text,
  add column if not exists setup_defaults jsonb not null default '{}';

alter table projects drop constraint if exists projects_customer_type_check;
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

alter table projects drop constraint if exists projects_default_operating_model_check;
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

create index if not exists workspaces_operating_model_idx
  on workspaces(operating_model, customer_type);

create index if not exists workspace_users_product_role_idx
  on workspace_users(workspace_id, product_role);
