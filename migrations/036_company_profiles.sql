create table if not exists company_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_scope text not null check (profile_scope in ('workspace_owner', 'platform_operator', 'crm_account')),
  workspace_id uuid references workspaces(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  legal_name text not null default '',
  display_name text not null default '',
  legal_form text not null default '',
  country_code text not null default '',
  jurisdiction text not null default '',
  registration_number text not null default '',
  registration_authority text not null default '',
  register_court text not null default '',
  vat_id text not null default '',
  tax_number text not null default '',
  registered_office_address text not null default '',
  business_address text not null default '',
  billing_address text not null default '',
  public_email text not null default '',
  public_phone text not null default '',
  website text not null default '',
  representatives jsonb not null default '[]',
  privacy_contact text not null default '',
  dpo_contact text not null default '',
  licenses jsonb not null default '{}',
  brand jsonb not null default '{}',
  usage_settings jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'needs_review', 'approved', 'locked')),
  approved_by_user_id uuid references workspace_users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (profile_scope = 'platform_operator' and workspace_id is null and organization_id is null)
    or (profile_scope = 'workspace_owner' and workspace_id is not null and organization_id is null)
    or (profile_scope = 'crm_account' and workspace_id is not null and organization_id is not null)
  )
);

alter table workspace_users drop constraint if exists workspace_users_status_check;
alter table workspace_users
  add constraint workspace_users_status_check
  check (status in ('active', 'invited', 'suspended'));

alter table company_profiles
  add column if not exists profile_scope text not null default 'workspace_owner',
  add column if not exists workspace_id uuid references workspaces(id) on delete cascade,
  add column if not exists organization_id uuid references organizations(id) on delete cascade,
  add column if not exists legal_name text not null default '',
  add column if not exists display_name text not null default '',
  add column if not exists legal_form text not null default '',
  add column if not exists country_code text not null default '',
  add column if not exists jurisdiction text not null default '',
  add column if not exists registration_number text not null default '',
  add column if not exists registration_authority text not null default '',
  add column if not exists register_court text not null default '',
  add column if not exists vat_id text not null default '',
  add column if not exists tax_number text not null default '',
  add column if not exists registered_office_address text not null default '',
  add column if not exists business_address text not null default '',
  add column if not exists billing_address text not null default '',
  add column if not exists public_email text not null default '',
  add column if not exists public_phone text not null default '',
  add column if not exists website text not null default '',
  add column if not exists representatives jsonb not null default '[]',
  add column if not exists privacy_contact text not null default '',
  add column if not exists dpo_contact text not null default '',
  add column if not exists licenses jsonb not null default '{}',
  add column if not exists brand jsonb not null default '{}',
  add column if not exists usage_settings jsonb not null default '{}',
  add column if not exists status text not null default 'draft',
  add column if not exists approved_by_user_id uuid references workspace_users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table company_profiles drop constraint if exists company_profiles_profile_scope_check;
alter table company_profiles
  add constraint company_profiles_profile_scope_check
  check (profile_scope in ('workspace_owner', 'platform_operator', 'crm_account'));

alter table company_profiles drop constraint if exists company_profiles_status_check;
alter table company_profiles
  add constraint company_profiles_status_check
  check (status in ('draft', 'needs_review', 'approved', 'locked'));

alter table company_profiles drop constraint if exists company_profiles_scope_owner_check;
alter table company_profiles
  add constraint company_profiles_scope_owner_check
  check (
    (profile_scope = 'platform_operator' and workspace_id is null and organization_id is null)
    or (profile_scope = 'workspace_owner' and workspace_id is not null and organization_id is null)
    or (profile_scope = 'crm_account' and workspace_id is not null and organization_id is not null)
  );

create table if not exists company_profile_versions (
  id uuid primary key default gen_random_uuid(),
  company_profile_id uuid not null references company_profiles(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  actor_user_id uuid references workspace_users(id) on delete set null,
  action text not null,
  before jsonb,
  after jsonb not null,
  changed_fields text[] not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists company_profiles_platform_operator_uidx
  on company_profiles(profile_scope)
  where profile_scope = 'platform_operator';

create unique index if not exists company_profiles_workspace_owner_uidx
  on company_profiles(workspace_id, profile_scope)
  where profile_scope = 'workspace_owner';

create unique index if not exists company_profiles_crm_account_uidx
  on company_profiles(workspace_id, organization_id)
  where profile_scope = 'crm_account';

create index if not exists company_profiles_workspace_scope_idx
  on company_profiles(workspace_id, profile_scope, status);

create index if not exists company_profile_versions_profile_created_idx
  on company_profile_versions(company_profile_id, created_at desc);

insert into company_profiles (
  profile_scope,
  legal_name,
  display_name,
  legal_form,
  country_code,
  jurisdiction,
  registration_number,
  registration_authority,
  registered_office_address,
  business_address,
  public_email,
  public_phone,
  website,
  representatives,
  privacy_contact,
  brand,
  usage_settings,
  status,
  approved_at
)
values (
  'platform_operator',
  'Novalure CLG',
  'Novalure CLG',
  'A company limited by guarantee incorporated under the laws of Ireland',
  'IE',
  'Dublin, Ireland',
  '796735',
  'Companies Registration Office (CRO), Ireland',
  '20 Harcourt Street, Dublin 2, D02 H364, Ireland',
  '20 Harcourt Street, Dublin 2, D02 H364, Ireland',
  'hello@novalure.eu',
  '+353 (0)89 269 5248',
  'https://www.novalure-crm.app',
  '[]'::jsonb,
  'hello@novalure.eu',
  jsonb_build_object('businessName', 'Novalure CLG'),
  jsonb_build_object(
    'imprint', true,
    'privacy', true,
    'emails', true,
    'legalFooter', true,
    'botDisclosures', true
  ),
  'approved',
  now()
)
on conflict do nothing;
