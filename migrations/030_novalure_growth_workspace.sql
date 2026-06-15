alter table workspaces
  add column if not exists slug text;

create unique index if not exists workspaces_slug_idx
  on workspaces(slug)
  where slug is not null;

alter table workspace_users drop constraint if exists workspace_users_product_role_check;
alter table workspace_users
  add constraint workspace_users_product_role_check
  check (
    product_role is null or product_role in (
      'platform_admin',
      'novalureGrowth',
      'novalureServiceOps',
      'novalureAdmin',
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

create table if not exists workspace_lead_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null,
  source_value text not null,
  label_de text not null,
  label_en text not null,
  position integer not null default 0,
  required boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, key),
  unique (workspace_id, source_value)
);

create index if not exists workspace_lead_sources_workspace_position_idx
  on workspace_lead_sources(workspace_id, position asc);

create table if not exists workspace_module_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  module_key text not null,
  enabled boolean not null default true,
  reason text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, module_key)
);

create index if not exists workspace_module_settings_workspace_idx
  on workspace_module_settings(workspace_id, module_key);

insert into workspaces (
  id,
  name,
  plan,
  slug,
  operating_model,
  customer_type,
  team_structure,
  active_calendar_provider,
  setup_state
)
values (
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'Novalure Growth',
  'Internal Dogfooding',
  'novalure-growth',
  'novalure_internal',
  'novalure_internal',
  'small_team',
  'none',
  jsonb_build_object(
    'workspaceKey', 'novalure-growth',
    'slug', 'novalure-growth',
    'defaultProfile', 'novalureGrowth',
    'visibility', jsonb_build_object(
      'internalProfiles', jsonb_build_array('novalureGrowth', 'novalureServiceOps', 'novalureAdmin'),
      'explicitMembershipRequiredForLegacyInternal', true
    ),
    'enabledModules', jsonb_build_object(
      'dashboard', true,
      'leadInbox', true,
      'contacts', true,
      'pipeline', true,
      'deals', true,
      'tasks', true,
      'calendar', true,
      'communication', true,
      'funnels', true,
      'newsletter', true,
      'bots', true,
      'knowledge', true,
      'analytics', true,
      'settings', true,
      'objectsMandates', false,
      'units', false,
      'reservations', false,
      'projectOverview', false
    ),
    'leadSources', jsonb_build_array('Website', 'Empfehlung', 'LinkedIn', 'Partner', 'Event', 'Newsletter', 'Outbound', 'Formular'),
    'createdByMigration', '030_novalure_growth_workspace'
  )
)
on conflict (id) do update
set
  name = excluded.name,
  plan = excluded.plan,
  slug = excluded.slug,
  operating_model = excluded.operating_model,
  customer_type = excluded.customer_type,
  team_structure = excluded.team_structure,
  active_calendar_provider = excluded.active_calendar_provider,
  setup_state = workspaces.setup_state || excluded.setup_state,
  updated_at = now();

insert into projects (
  id,
  workspace_id,
  name,
  type,
  status,
  customer_type,
  default_operating_model,
  setup_defaults
)
values (
  'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'Novalure Eigenakquise',
  'internal_growth',
  'Aktiv',
  'novalure_internal',
  'novalure_internal',
  jsonb_build_object(
    'defaultProfile', 'novalureGrowth',
    'pipelineKey', 'novalure_growth_pipeline',
    'workspaceKey', 'novalure-growth'
  )
)
on conflict (id) do update
set
  name = excluded.name,
  type = excluded.type,
  status = excluded.status,
  customer_type = excluded.customer_type,
  default_operating_model = excluded.default_operating_model,
  setup_defaults = projects.setup_defaults || excluded.setup_defaults,
  updated_at = now();

insert into crm_pipelines (
  id,
  workspace_id,
  project_id,
  customer_type,
  operating_model,
  key,
  name,
  purpose,
  is_default,
  metadata
)
values (
  'a5cf82f8-c6f4-4517-a0f6-9d9f17601830',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',
  'novalure_internal',
  'novalure_internal',
  'novalure_growth_pipeline',
  'Novalure Growth Pipeline',
  'novalure_growth',
  true,
  jsonb_build_object('stageHistoryRequired', true, 'auditRequired', true, 'reasonRequiredOnStageChange', true)
)
on conflict (id) do update
set
  key = excluded.key,
  name = excluded.name,
  purpose = excluded.purpose,
  is_default = excluded.is_default,
  metadata = crm_pipelines.metadata || excluded.metadata,
  updated_at = now();

update projects
set
  default_pipeline_id = 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830',
  updated_at = now()
where id = 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2';

insert into crm_pipeline_stages (
  id,
  pipeline_id,
  workspace_id,
  project_id,
  key,
  name,
  position,
  probability,
  category,
  metadata
)
values
  ('7b6ac3fa-3a73-4b60-9d3e-909a41f12a01', 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'new', 'Neu', 0, 5, 'work', jsonb_build_object('labelEn', 'New')),
  ('7b6ac3fa-3a73-4b60-9d3e-909a41f12a02', 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'qualified', 'Qualifiziert', 1, 20, 'work', jsonb_build_object('labelEn', 'Qualified')),
  ('7b6ac3fa-3a73-4b60-9d3e-909a41f12a03', 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'demo_booked', 'Demo gebucht', 2, 35, 'work', jsonb_build_object('labelEn', 'Demo booked')),
  ('7b6ac3fa-3a73-4b60-9d3e-909a41f12a04', 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'demo_held', 'Demo gehalten', 3, 50, 'work', jsonb_build_object('labelEn', 'Demo held')),
  ('7b6ac3fa-3a73-4b60-9d3e-909a41f12a05', 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'offer', 'Angebot', 4, 65, 'work', jsonb_build_object('labelEn', 'Offer')),
  ('7b6ac3fa-3a73-4b60-9d3e-909a41f12a06', 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'pilot', 'Pilot', 5, 80, 'work', jsonb_build_object('labelEn', 'Pilot')),
  ('7b6ac3fa-3a73-4b60-9d3e-909a41f12a07', 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'won', 'Gewonnen', 6, 100, 'won', jsonb_build_object('labelEn', 'Won')),
  ('7b6ac3fa-3a73-4b60-9d3e-909a41f12a08', 'a5cf82f8-c6f4-4517-a0f6-9d9f17601830', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'lost', 'Verloren', 7, 0, 'lost', jsonb_build_object('labelEn', 'Lost'))
on conflict (id) do update
set
  key = excluded.key,
  name = excluded.name,
  position = excluded.position,
  probability = excluded.probability,
  category = excluded.category,
  metadata = crm_pipeline_stages.metadata || excluded.metadata,
  updated_at = now();

insert into workspace_lead_sources (
  id,
  workspace_id,
  key,
  source_value,
  label_de,
  label_en,
  position,
  required,
  metadata
)
values
  ('2fd456d4-04c0-4034-b76b-77051d24b401', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'website', 'Website', 'Website', 'Website', 0, true, jsonb_build_object('analyticsKey', 'website')),
  ('2fd456d4-04c0-4034-b76b-77051d24b402', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'referral', 'Empfehlung', 'Empfehlung', 'Referral', 1, true, jsonb_build_object('analyticsKey', 'referral')),
  ('2fd456d4-04c0-4034-b76b-77051d24b403', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'linkedin', 'LinkedIn', 'LinkedIn', 'LinkedIn', 2, true, jsonb_build_object('analyticsKey', 'linkedin')),
  ('2fd456d4-04c0-4034-b76b-77051d24b404', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'partner', 'Partner', 'Partner', 'Partner', 3, true, jsonb_build_object('analyticsKey', 'partner')),
  ('2fd456d4-04c0-4034-b76b-77051d24b405', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'event', 'Event', 'Event', 'Event', 4, true, jsonb_build_object('analyticsKey', 'event')),
  ('2fd456d4-04c0-4034-b76b-77051d24b406', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'newsletter', 'Newsletter', 'Newsletter', 'Newsletter', 5, true, jsonb_build_object('analyticsKey', 'newsletter')),
  ('2fd456d4-04c0-4034-b76b-77051d24b407', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'outbound', 'Outbound', 'Outbound', 'Outbound', 6, true, jsonb_build_object('analyticsKey', 'outbound')),
  ('2fd456d4-04c0-4034-b76b-77051d24b408', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'form', 'Formular', 'Formular', 'Form', 7, true, jsonb_build_object('analyticsKey', 'form'))
on conflict (id) do update
set
  key = excluded.key,
  source_value = excluded.source_value,
  label_de = excluded.label_de,
  label_en = excluded.label_en,
  position = excluded.position,
  required = excluded.required,
  metadata = workspace_lead_sources.metadata || excluded.metadata,
  updated_at = now();

insert into workspace_module_settings (
  id,
  workspace_id,
  module_key,
  enabled,
  reason,
  metadata
)
values
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb901', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'dashboard', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb902', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'leadInbox', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb903', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'contacts', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb904', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'pipeline', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb905', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'deals', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb906', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'tasks', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb907', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'calendar', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb908', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'communication', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb909', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'funnels', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb910', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'newsletter', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb911', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'bots', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb912', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'knowledge', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb913', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'analytics', true, 'standard CRM module for internal dogfooding', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb914', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'settings', true, 'workspace settings remain governed by profile RBAC', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb915', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'objectsMandates', false, 'real-estate module is not relevant for Novalure Eigenakquise', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb916', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'units', false, 'real-estate inventory module is not relevant for Novalure Eigenakquise', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb917', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'reservations', false, 'real-estate reservation module is not relevant for Novalure Eigenakquise', '{}'),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb918', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'projectOverview', false, 'real-estate project overview is not relevant for Novalure Eigenakquise', '{}')
on conflict (id) do update
set
  module_key = excluded.module_key,
  enabled = excluded.enabled,
  reason = excluded.reason,
  metadata = workspace_module_settings.metadata || excluded.metadata,
  updated_at = now();

insert into bots (
  id,
  workspace_id,
  project_id,
  name,
  role,
  status,
  model,
  strict_knowledge,
  description,
  audience,
  language,
  tone,
  answer_length,
  brand_voice,
  config
)
values
  (
    '5f4c8d29-d7fc-4c0c-9f0b-82a9a3e17101',
    '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
    'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',
    'Demo-Anfrage-Bot',
    'sales_qualifier',
    'inactive',
    'openai/gpt-5.4',
    true,
    'Qualifiziert Demo-Anfragen, bucht Termine und schreibt Lead plus Termin in den Growth-Workspace.',
    'Website-Demo-Anfragen',
    'de',
    'praezise, beratend, datenschutzbewusst',
    'normal',
    'Novalure Growth',
    jsonb_build_object('seedKey', 'demo_request_bot', 'activationRole', 'novalureAdmin', 'tenantScope', 'novalure-growth', 'actions', jsonb_build_array('qualify_lead', 'book_demo', 'create_lead', 'create_calendar_event'), 'policyRequired', true, 'statusOnSeed', 'inactive')
  ),
  (
    '5f4c8d29-d7fc-4c0c-9f0b-82a9a3e17102',
    '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
    'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',
    'Outbound-Recherche-Bot',
    'crm_data_agent',
    'inactive',
    'openai/gpt-5.4',
    true,
    'Reichert Kontakte mit oeffentlich verfuegbaren Firmen- und Rollendaten an.',
    'Novalure Sales Research',
    'de',
    'faktenbasiert, vorsichtig, auditierbar',
    'kurz',
    'Novalure Growth',
    jsonb_build_object('seedKey', 'outbound_research_bot', 'activationRole', 'novalureAdmin', 'tenantScope', 'novalure-growth', 'governancePolicyRequired', true, 'auditLogRequired', true, 'dataSources', jsonb_build_array('public_company_data', 'public_role_data'), 'statusOnSeed', 'inactive')
  ),
  (
    '5f4c8d29-d7fc-4c0c-9f0b-82a9a3e17103',
    '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
    'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',
    'Demo-Follow-up-Bot',
    'sales_qualifier',
    'inactive',
    'openai/gpt-5.4',
    true,
    'Schlaegt nach gehaltener Demo naechste Schritte vor und erzeugt Aufgaben sowie Mail-Entwuerfe.',
    'Novalure Growth Team',
    'de',
    'konkret, vertriebsnah, transparent',
    'normal',
    'Novalure Growth',
    jsonb_build_object('seedKey', 'demo_follow_up_bot', 'activationRole', 'novalureAdmin', 'tenantScope', 'novalure-growth', 'actions', jsonb_build_array('suggest_next_step', 'create_task', 'draft_email'), 'statusOnSeed', 'inactive')
  ),
  (
    '5f4c8d29-d7fc-4c0c-9f0b-82a9a3e17104',
    '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
    'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',
    'Pilot-Check-in-Bot',
    'onboarding_agent',
    'inactive',
    'openai/gpt-5.4',
    true,
    'Erinnert an Check-ins im Pilot, fragt Nutzungsdaten ab und eskaliert Risiko-Signale an Owner.',
    'Pilotkunden im Novalure Growth Workspace',
    'de',
    'proaktiv, praezise, kundenorientiert',
    'normal',
    'Novalure Growth',
    jsonb_build_object('seedKey', 'pilot_check_in_bot', 'activationRole', 'novalureAdmin', 'tenantScope', 'novalure-growth', 'actions', jsonb_build_array('schedule_check_in', 'collect_usage_signal', 'escalate_owner_risk'), 'statusOnSeed', 'inactive')
  ),
  (
    '5f4c8d29-d7fc-4c0c-9f0b-82a9a3e17105',
    '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
    'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',
    'Wissens-Bot',
    'support_agent',
    'inactive',
    'openai/gpt-5.4',
    true,
    'Beantwortet interne Sales-Fragen aus Pricing, Einwaenden, Demo-Skripten und Feature-Vergleichen.',
    'Novalure Growth Team',
    'de',
    'sachlich, hilfreich, quellennah',
    'normal',
    'Novalure Growth',
    jsonb_build_object('seedKey', 'knowledge_bot', 'activationRole', 'novalureAdmin', 'tenantScope', 'novalure-growth', 'knowledgeOnly', true, 'statusOnSeed', 'inactive')
  )
on conflict (id) do update
set
  name = excluded.name,
  role = excluded.role,
  status = excluded.status,
  strict_knowledge = excluded.strict_knowledge,
  description = excluded.description,
  audience = excluded.audience,
  language = excluded.language,
  tone = excluded.tone,
  answer_length = excluded.answer_length,
  brand_voice = excluded.brand_voice,
  config = bots.config || excluded.config,
  updated_at = now();

insert into knowledge_sources (
  id,
  workspace_id,
  project_id,
  name,
  source_type,
  status,
  coverage,
  item_count,
  location,
  metadata
)
values
  ('90670872-8750-4a21-97cd-a9d79d395401', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'Pricing', 'manual', 'needs-review', '', 0, 'novalure-growth/pricing', jsonb_build_object('sectionKey', 'pricing', 'emptySeed', true)),
  ('90670872-8750-4a21-97cd-a9d79d395402', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'Einwaende', 'manual', 'needs-review', '', 0, 'novalure-growth/einwaende', jsonb_build_object('sectionKey', 'objections', 'labelDe', 'Einwaende', 'labelEn', 'Objections', 'emptySeed', true)),
  ('90670872-8750-4a21-97cd-a9d79d395403', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'Demo-Ablauf', 'manual', 'needs-review', '', 0, 'novalure-growth/demo-ablauf', jsonb_build_object('sectionKey', 'demo_flow', 'labelEn', 'Demo flow', 'emptySeed', true)),
  ('90670872-8750-4a21-97cd-a9d79d395404', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'Konkurrenz', 'manual', 'needs-review', '', 0, 'novalure-growth/konkurrenz', jsonb_build_object('sectionKey', 'competition', 'labelEn', 'Competition', 'emptySeed', true)),
  ('90670872-8750-4a21-97cd-a9d79d395405', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'Onboarding-Argumente', 'manual', 'needs-review', '', 0, 'novalure-growth/onboarding-argumente', jsonb_build_object('sectionKey', 'onboarding_arguments', 'labelEn', 'Onboarding arguments', 'emptySeed', true)),
  ('90670872-8750-4a21-97cd-a9d79d395406', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'Pilot-Konditionen', 'manual', 'needs-review', '', 0, 'novalure-growth/pilot-konditionen', jsonb_build_object('sectionKey', 'pilot_terms', 'labelEn', 'Pilot terms', 'emptySeed', true))
on conflict (id) do update
set
  name = excluded.name,
  source_type = excluded.source_type,
  status = excluded.status,
  coverage = excluded.coverage,
  item_count = excluded.item_count,
  location = excluded.location,
  metadata = knowledge_sources.metadata || excluded.metadata,
  updated_at = now();

insert into funnels (
  id,
  workspace_id,
  project_id,
  name,
  goal,
  audience,
  entry_channel,
  status,
  blueprint,
  tracking
)
values
  ('67d1ab8a-2b52-467d-bd55-4cdd41c73401', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'Demo-Anfrage Website', 'Demo-Anfrage qualifizieren und Termin buchen', 'Website-Besucher', 'Website', 'entwurf', jsonb_build_object('seedKey', 'website_demo', 'disabled', true, 'requiresConsent', true), jsonb_build_object('leadSource', 'Formular', 'analytics', 'channel_to_won_conversion')),
  ('67d1ab8a-2b52-467d-bd55-4cdd41c73402', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'LinkedIn Outbound', 'Outbound-Kontakte strukturiert in Demo-Pipeline ueberfuehren', 'LinkedIn-Kontakte', 'LinkedIn', 'entwurf', jsonb_build_object('seedKey', 'linkedin_outbound', 'disabled', true, 'requiresConsent', true), jsonb_build_object('leadSource', 'LinkedIn', 'analytics', 'channel_to_won_conversion')),
  ('67d1ab8a-2b52-467d-bd55-4cdd41c73403', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2', 'Empfehlungsprogramm', 'Empfehlungen erfassen, qualifizieren und nachverfolgen', 'Partner und Bestandskontakte', 'Empfehlung', 'entwurf', jsonb_build_object('seedKey', 'referral_program', 'disabled', true, 'requiresConsent', true), jsonb_build_object('leadSource', 'Empfehlung', 'analytics', 'channel_to_won_conversion'))
on conflict (id) do update
set
  name = excluded.name,
  goal = excluded.goal,
  audience = excluded.audience,
  entry_channel = excluded.entry_channel,
  status = excluded.status,
  blueprint = funnels.blueprint || excluded.blueprint,
  tracking = funnels.tracking || excluded.tracking,
  updated_at = now();

insert into audit_logs (
  workspace_id,
  actor_user_id,
  action,
  entity_type,
  entity_id,
  before,
  after
)
select
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  null,
  'workspace.seeded',
  'workspace',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  null,
  jsonb_build_object(
    'migration', '030_novalure_growth_workspace',
    'workspace', 'Novalure Growth',
    'profiles', jsonb_build_array('novalureGrowth', 'novalureServiceOps', 'novalureAdmin')
  )
where not exists (
  select 1
  from audit_logs
  where workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
    and action = 'workspace.seeded'
    and entity_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
);
