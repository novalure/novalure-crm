#!/usr/bin/env node

throw new Error(
  "Direct property-department migration is disabled. Apply 034_property_department and 035_property_department_content separately through scripts/db-migrate.mjs with an explicit MIGRATION_TARGET and dry-run.",
);
