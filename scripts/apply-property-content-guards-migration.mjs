#!/usr/bin/env node

throw new Error(
  "Direct property-content-guards migration is disabled. Use scripts/db-migrate.mjs with an explicit MIGRATION_TARGET and the checksummed migration 039_property_content_partial_unique_indexes.",
);
