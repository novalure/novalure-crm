update workspaces
set
  setup_state = jsonb_set(
    setup_state,
    '{leadSources}',
    (
      select jsonb_agg(
        case
          when source_value #>> '{}' = 'Demo-Formular' then to_jsonb('Formular'::text)
          else source_value
        end
      )
      from jsonb_array_elements(setup_state->'leadSources') as source_items(source_value)
    ),
    true
  ),
  updated_at = now()
where setup_state->'leadSources' @> '["Demo-Formular"]'::jsonb;

update workspace_lead_sources
set
  key = 'form',
  source_value = 'Formular',
  label_de = 'Formular',
  label_en = 'Form',
  metadata = (metadata - 'analyticsKey') || jsonb_build_object('analyticsKey', 'form'),
  updated_at = now()
where (key = 'demo_form' or source_value = 'Demo-Formular')
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
  metadata = (metadata - 'analyticsKey') || jsonb_build_object('analyticsKey', 'form'),
  updated_at = now()
where key = 'form' or source_value = 'Formular';

delete from workspace_lead_sources legacy
using workspace_lead_sources replacement
where legacy.workspace_id = replacement.workspace_id
  and legacy.id <> replacement.id
  and (legacy.key = 'demo_form' or legacy.source_value = 'Demo-Formular')
  and (replacement.key = 'form' or replacement.source_value = 'Formular');

update funnels
set
  tracking = jsonb_set(tracking, '{leadSource}', to_jsonb('Formular'::text), true),
  updated_at = now()
where tracking->>'leadSource' = 'Demo-Formular';
