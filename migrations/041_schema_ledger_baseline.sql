-- Schema ledger baseline for the approved Schema Reconciliation Stage 1 plan.
-- The migration runner records this file as 041_schema_ledger_baseline with its SHA-256 checksum.
-- Historical migrations 001-040 are intentionally not inserted as artificial ledger rows.
-- Existing legacy ledger rows, including Test ghost entries 029/030, are intentionally left unchanged.

create table if not exists novalure_schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);
