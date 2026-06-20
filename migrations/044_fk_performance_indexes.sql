-- Additive performance indexes for the workspace-scoped CRM read paths.
-- The migration runner executes migrations inside a transaction, so CREATE INDEX
-- CONCURRENTLY is intentionally not used here.

create index if not exists leads_workspace_received_idx
  on leads (workspace_id, received_at desc);

create index if not exists deals_workspace_updated_idx
  on deals (workspace_id, updated_at desc);

create index if not exists seller_listings_workspace_created_idx
  on seller_listings (workspace_id, created_at desc, id desc);

create index if not exists property_units_workspace_project_unit_idx
  on property_units (workspace_id, project_id, unit_number asc, id asc);

create index if not exists property_reservations_workspace_project_expires_idx
  on property_reservations (workspace_id, project_id, expires_at asc);
