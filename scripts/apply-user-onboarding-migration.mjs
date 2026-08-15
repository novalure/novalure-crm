#!/usr/bin/env node

throw new Error(
  "Direct user-onboarding migration is disabled. Use scripts/db-migrate.mjs with an explicit MIGRATION_TARGET and the checksummed migration 031_user_onboarding.",
);
