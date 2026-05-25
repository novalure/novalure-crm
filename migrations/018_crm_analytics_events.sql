alter table analytics_events
  add column if not exists entity_id uuid,
  add column if not exists entity_type text,
  add column if not exists module text,
  add column if not exists user_id uuid references workspace_users(id) on delete set null,
  add column if not exists created_at timestamptz not null default now();

update analytics_events
set
  entity_id = coalesce(deal_id, lead_id, contact_id, funnel_id),
  entity_type = case
    when deal_id is not null then 'deal'
    when lead_id is not null then 'lead'
    when contact_id is not null then 'contact'
    when funnel_id is not null then 'funnel'
    else entity_type
  end,
  module = case
    when event_type like 'deal_%' then 'pipeline'
    when event_type like 'funnel_%' then 'funnel'
    when event_type like 'newsletter_%' then 'newsletter'
    when event_type like 'dashboard_%' then 'dashboard'
    when event_type like 'contact_%' or event_type like 'lead_%' then 'lead_inbox'
    when event_type like 'booking_%' or event_type like 'meeting_%' then 'meeting'
    else module
  end
where entity_id is null or entity_type is null or module is null;

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
