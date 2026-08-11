#!/usr/bin/env node

throw new Error(
  "Direct Novalure-growth migration is disabled. Apply 030_novalure_growth_workspace and 037_novalure_growth_alignment separately through scripts/db-migrate.mjs with an explicit MIGRATION_TARGET and dry-run.",
);
