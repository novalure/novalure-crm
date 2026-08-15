#!/usr/bin/env node

throw new Error(
  "Direct property-default-units migration is disabled. Use scripts/db-migrate.mjs with an explicit MIGRATION_TARGET and the checksummed migration 038_property_default_units.",
);
