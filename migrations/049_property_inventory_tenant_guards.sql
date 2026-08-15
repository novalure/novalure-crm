-- Add tenant-qualified parent keys before enforcing new inventory writes.
-- The existing primary/unique keys make these indexes data-compatible.
create unique index if not exists projects_workspace_id_id_uidx
  on projects(workspace_id, id);

create unique index if not exists property_buildings_workspace_project_id_uidx
  on property_buildings(workspace_id, project_id, id);

create unique index if not exists property_units_workspace_project_id_uidx
  on property_units(workspace_id, project_id, id);

create unique index if not exists property_units_workspace_project_unit_uidx
  on property_units(workspace_id, project_id, unit_number);

create index if not exists property_reservations_workspace_project_unit_idx
  on property_reservations(workspace_id, project_id, unit_id);

-- NOT VALID keeps legacy rows deployable while every new or changed row is
-- required to preserve the workspace/project relationship.
do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'property_buildings_workspace_project_fk'
      and conrelid = 'property_buildings'::regclass
  ) then
    alter table property_buildings
      add constraint property_buildings_workspace_project_fk
      foreign key (workspace_id, project_id)
      references projects(workspace_id, id)
      on delete cascade
      not valid;
  end if;
end;
$migration$;

-- Keep the legacy building_id ON DELETE SET NULL behavior: the tenant-qualified
-- check runs at transaction end, after the existing single-column FK clears it.
do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'property_units_workspace_project_building_fk'
      and conrelid = 'property_units'::regclass
  ) then
    alter table property_units
      add constraint property_units_workspace_project_building_fk
      foreign key (workspace_id, project_id, building_id)
      references property_buildings(workspace_id, project_id, id)
      deferrable initially deferred
      not valid;
  end if;
end;
$migration$;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'property_units_workspace_project_fk'
      and conrelid = 'property_units'::regclass
  ) then
    alter table property_units
      add constraint property_units_workspace_project_fk
      foreign key (workspace_id, project_id)
      references projects(workspace_id, id)
      on delete cascade
      not valid;
  end if;
end;
$migration$;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'property_reservations_workspace_project_fk'
      and conrelid = 'property_reservations'::regclass
  ) then
    alter table property_reservations
      add constraint property_reservations_workspace_project_fk
      foreign key (workspace_id, project_id)
      references projects(workspace_id, id)
      on delete cascade
      not valid;
  end if;
end;
$migration$;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'property_reservations_workspace_project_unit_fk'
      and conrelid = 'property_reservations'::regclass
  ) then
    alter table property_reservations
      add constraint property_reservations_workspace_project_unit_fk
      foreign key (workspace_id, project_id, unit_id)
      references property_units(workspace_id, project_id, id)
      on delete cascade
      not valid;
  end if;
end;
$migration$;
