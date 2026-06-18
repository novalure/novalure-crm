create unique index if not exists property_text_blocks_property_only_uidx
  on property_text_blocks(workspace_id, property_id, text_key, channel)
  where property_id is not null and unit_id is null;

create unique index if not exists property_text_blocks_unit_only_uidx
  on property_text_blocks(workspace_id, unit_id, text_key, channel)
  where unit_id is not null and property_id is null;

create unique index if not exists property_cost_items_property_only_uidx
  on property_cost_items(workspace_id, property_id, cost_key)
  where property_id is not null and unit_id is null;

create unique index if not exists property_cost_items_unit_only_uidx
  on property_cost_items(workspace_id, unit_id, cost_key)
  where unit_id is not null and property_id is null;
