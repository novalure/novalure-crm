-- Dedicated, versioned internal form identity for novalurestudio.ie.
-- The public website reaches this data only through the signed ingestion route;
-- no browser receives CRM credentials or a direct database path.

insert into forms (
  id, workspace_id, project_id, name, slug, status, variant, template,
  crm_target, pipeline_stage, owner_mode, campaign, tags, fields, actions, settings
)
values (
  '0f98b9fd-d300-4a34-a14c-54a1a61b2415',
  '8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101',
  'f7d83c6b-d08d-4d73-b822-1f1c0b4733d2',
  'Novalure Studio Website Sales',
  'novalure-studio-website-sales-v1',
  'aktiv',
  'embed',
  'consultation',
  'deal',
  'new',
  'roundRobin',
  'novalure_studio',
  array['WEBSITE_SALES', 'NOVALURE_STUDIO_FORM'],
  '[
    {"id":"name","crmField":"name","label":"Contact name","type":"text","required":true},
    {"id":"email","crmField":"email","label":"Business email","type":"email","required":true},
    {"id":"company","crmField":"company","label":"Business name","type":"company","required":false},
    {"id":"phone","crmField":"phone","label":"Phone","type":"phone","required":false},
    {"id":"current_website_url","crmField":"current_website_url","label":"Existing website","type":"url","required":false},
    {"id":"package_interest","crmField":"package_interest","label":"Package interest","type":"select","required":true,"options":["STARTER","BUSINESS","PREMIUM","MANAGED_CARE","PERFORMANCE","CONVERSION","UNDECIDED","CUSTOM"]},
    {"id":"message","crmField":"message","label":"Project brief","type":"textarea","required":true},
    {"id":"privacy","crmField":"privacy","label":"Privacy consent","type":"consent","required":true},
    {"id":"utm_source","crmField":"utm_source","label":"UTM source","type":"hidden","required":false},
    {"id":"utm_medium","crmField":"utm_medium","label":"UTM medium","type":"hidden","required":false},
    {"id":"utm_campaign","crmField":"utm_campaign","label":"UTM campaign","type":"hidden","required":false},
    {"id":"utm_content","crmField":"utm_content","label":"UTM content","type":"hidden","required":false},
    {"id":"utm_term","crmField":"utm_term","label":"UTM term","type":"hidden","required":false},
    {"id":"page_url","crmField":"page_url","label":"Page URL","type":"hidden","required":false},
    {"id":"landing_page","crmField":"landing_page","label":"Landing page","type":"hidden","required":false},
    {"id":"referrer","crmField":"referrer","label":"Referrer","type":"hidden","required":false},
    {"id":"synthetic_test","crmField":"synthetic_test","label":"Synthetic test marker","type":"hidden","required":false}
  ]'::jsonb,
  '{"createTask":true,"followUpEmail":false,"internalNotification":true,"newsletterList":false,"redirectUrl":"","showMeeting":false,"thankYouMessage":"Thank you."}'::jsonb,
  '{"utmCapture":true,"websiteSales":{"businessLine":"WEBSITE_SALES","contractVersion":"website-sales-lead-v1","leadSource":"NOVALURE_STUDIO_FORM","pipeline":"WEBSITE_SALES"}}'::jsonb
)
on conflict (id) do update
set
  name = excluded.name,
  status = excluded.status,
  crm_target = excluded.crm_target,
  pipeline_stage = excluded.pipeline_stage,
  campaign = excluded.campaign,
  tags = excluded.tags,
  fields = excluded.fields,
  actions = excluded.actions,
  settings = forms.settings || excluded.settings,
  updated_at = now();

create index if not exists leads_website_sales_business_line_idx
  on leads ((metadata->>'businessLine'))
  where metadata->>'businessLine' = 'WEBSITE_SALES';

create index if not exists deals_website_sales_business_line_idx
  on deals ((metadata->>'businessLine'))
  where metadata->>'businessLine' = 'WEBSITE_SALES';
