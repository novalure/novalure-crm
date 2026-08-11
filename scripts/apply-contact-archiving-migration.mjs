#!/usr/bin/env node

throw new Error(
  "Direct contact-archiving migration is disabled. Use scripts/db-migrate.mjs with an explicit MIGRATION_TARGET and the checksummed migration 028_contact_archiving.",
);
