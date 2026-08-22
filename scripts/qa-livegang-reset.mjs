#!/usr/bin/env node

// Intentionally disabled. The legacy implementation deleted deterministic
// workspace roots directly and could not prove is_qa, batch membership,
// referential closure, CSRF, platform-admin authorization, or immutable audit.
// Keeping that path executable would bypass DB-01 even after the safe API and
// migration exist.

const message = [
  "Legacy QA Livegang reset is disabled by DB-01.",
  "Apply migration 068 only after an approved database dry-run/backup, provision at least two explicit is_qa tenants,",
  "register every QA object in qa_batch_objects, then use POST /api/admin/qa-reset (dry_run is the default).",
  "Execution additionally requires the server-side allowlist, execution gate, exact workspace+batch confirmation,",
  "a persisted platform-admin session, required capabilities, CSRF, a closed database graph, and external cleanup adapters.",
].join(" ");

console.error(message);
process.exitCode = 1;
