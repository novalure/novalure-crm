-- The 049 preflight verified that legacy inventory rows are tenant-consistent.
-- Validate the additive constraints in a separate release step so every
-- environment reaches the same enforced state after its own preflight.
alter table property_buildings
  validate constraint property_buildings_workspace_project_fk;

alter table property_units
  validate constraint property_units_workspace_project_building_fk;

alter table property_units
  validate constraint property_units_workspace_project_fk;

alter table property_reservations
  validate constraint property_reservations_workspace_project_fk;

alter table property_reservations
  validate constraint property_reservations_workspace_project_unit_fk;
