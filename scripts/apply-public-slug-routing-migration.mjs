#!/usr/bin/env node

throw new Error(
  "Direct public-slug-routing migration is disabled. Use scripts/db-migrate.mjs with an explicit MIGRATION_TARGET and the checksummed migration 032_public_slug_routing.",
);
