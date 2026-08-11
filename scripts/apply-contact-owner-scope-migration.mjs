#!/usr/bin/env node

throw new Error(
  "Direct contact-owner-scope migration is disabled. Use scripts/db-migrate.mjs with an explicit MIGRATION_TARGET and the checksummed migration 029_contact_owner_scope.",
);
