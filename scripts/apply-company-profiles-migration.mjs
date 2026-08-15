#!/usr/bin/env node

throw new Error(
  "Direct company-profile migration is disabled. Use MIGRATION_TARGET=<test|prod> node scripts/db-migrate.mjs <dry-run|up> --only=036_company_profiles.",
);
