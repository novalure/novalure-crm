create unique index if not exists property_reservations_one_active_per_unit_idx
  on property_reservations(workspace_id, unit_id)
  where status in ('hold', 'reserved');
