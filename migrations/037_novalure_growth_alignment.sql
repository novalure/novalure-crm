update workspaces
set
  setup_state = jsonb_set(
    jsonb_set(
      coalesce(setup_state, '{}'::jsonb),
      '{enabledModules}',
      coalesce(setup_state->'enabledModules', '{}'::jsonb) || jsonb_build_object(
        'properties', true,
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
        'objectsMandates', true,
        'units', true,
        'reservations', true,
        'projectOverview', true
      ),
      true
    ),
    '{leadSources}',
    jsonb_build_array('Website', 'Empfehlung', 'LinkedIn', 'Partner', 'Event', 'Newsletter', 'Outbound', 'Formular'),
    true
  ),
  updated_at = now()
where id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101';

update workspace_lead_sources
set
  key = 'form',
  source_value = 'Formular',
  label_de = 'Formular',
  label_en = 'Form',
  position = 7,
  required = true,
  metadata = (metadata - 'analyticsKey') || jsonb_build_object('analyticsKey', 'form'),
  updated_at = now()
where workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and (id = '2fd456d4-04c0-4034-b76b-77051d24b408' or key = 'demo_form' or source_value = 'Demo-Formular')
  and not exists (
    select 1
    from workspace_lead_sources existing
    where existing.workspace_id = workspace_lead_sources.workspace_id
      and existing.id <> workspace_lead_sources.id
      and (existing.key = 'form' or existing.source_value = 'Formular')
  );

update workspace_lead_sources
set
  key = 'form',
  source_value = 'Formular',
  label_de = 'Formular',
  label_en = 'Form',
  position = 7,
  required = true,
  metadata = (metadata - 'analyticsKey') || jsonb_build_object('analyticsKey', 'form'),
  updated_at = now()
where workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and (key = 'form' or source_value = 'Formular');

update funnels
set
  tracking = jsonb_set(tracking, '{leadSource}', to_jsonb('Formular'::text), true),
  updated_at = now()
where workspace_id = '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101'
  and tracking->>'leadSource' = 'Demo-Formular';

insert into workspace_module_settings (
  id,
  workspace_id,
  module_key,
  enabled,
  reason,
  metadata
)
values
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb919', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'properties', true, 'Growth workspace uses the full CRM module set for internal dogfooding', jsonb_build_object('alignedByMigration', '037_novalure_growth_alignment')),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb915', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'objectsMandates', true, 'Growth workspace uses the full CRM module set for internal dogfooding', jsonb_build_object('alignedByMigration', '037_novalure_growth_alignment')),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb916', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'units', true, 'Growth workspace uses the full CRM module set for internal dogfooding', jsonb_build_object('alignedByMigration', '037_novalure_growth_alignment')),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb917', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'reservations', true, 'Growth workspace uses the full CRM module set for internal dogfooding', jsonb_build_object('alignedByMigration', '037_novalure_growth_alignment')),
  ('8151a41c-81a9-4b26-80b0-dfbb6e4fb918', '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101', 'projectOverview', true, 'Growth workspace uses the full CRM module set for internal dogfooding', jsonb_build_object('alignedByMigration', '037_novalure_growth_alignment'))
on conflict (workspace_id, module_key) do update
set
  enabled = excluded.enabled,
  reason = excluded.reason,
  metadata = workspace_module_settings.metadata || excluded.metadata,
  updated_at = now();
