# U1-C03 Production source reconciliation

Status: **BLOCKED_EXTERNAL**. This branch is a recovery and safe-migration package, not a deployable reconciliation candidate. No Production deployment, migration, environment, secret, domain, customer-data or outbound change was made.

## Provenance and exact inventory

The U1 input is commit `29ae7d1d452297a6370c0292a62b8e5b2643e27c` (557 tracked files). The current Production deployment is `dpl_ESYdRFQruH4CcsMnmrnBhZ5vQqah`, created by CLI at `2026-09-13T11:31:59Z`. It contains no Git commit or branch metadata. The read-only deployment tree exposed 152 source paths and is depth-limited.

The comparison found exactly 43 visible Production-only files. Their exact paths, Vercel file IDs and subsystem classifications are in [`config/u1-c03-production-source-manifest.json`](../../config/u1-c03-production-source-manifest.json). The inventory covers Property Core Editor (8), Exposé Workspace/PDF (9), Media Gallery (7), Document Review (2), Purchase Costs (4), Relationship Editor (3), other Property modules (8), auth/runtime (1), and CRM core (1).

No reachable Git ref contains the identified source paths. The authorized deployment-file reader truncates large file bodies, so it cannot reconstruct byte-identical sources. A partial or inferred rewrite would risk deleting Production behavior and is deliberately excluded. Recovery requires an untruncated export of that deployment or its original working tree, followed by verification against every recorded Vercel file ID.

## Migration 087 deployment model

The original migration combined required columns, backfill, `NOT NULL`, strict triggers and constraints. That makes the previous writer unsafe and provides no practical rollback window.

The redesigned sequence is:

1. **Expand:** apply `migrations/087_d11_crm_source_of_truth_closure.sql`. It adds nullable fields, additive types, compatibility triggers, a digest function and a bounded backfill function. The old writer remains valid.
2. **Backfill:** invoke `migrations/staged/087_d11_crm_source_of_truth_backfill.sql` repeatedly. Each run updates no more than 500 rows per relation, uses `SKIP LOCKED`, records counts in `crm_d11_migration_audit`, and is resumable/idempotent. It never invents Owner authority. Invalid proposal bindings remain visible blockers requiring a new explicit revision.
3. **Dual-compatible application:** deploy the exact tested candidate only after Production source recovery and Preview QA. It must tolerate nullable pre-Contract fields while writing the canonical values.
4. **Validate:** require every remaining count to be zero, compare SQL and TypeScript owner-digest vectors, complete restore/RLS/browser checks, and record owner approval.
5. **Contract:** separately approve and apply `migrations/staged/087_d11_crm_source_of_truth_contract.sql`. It fails closed on remaining rows, then enables `NOT NULL`, exact proposal payloads, division immutability and Owner-only A3 triggers.

No staged SQL file is discovered by the normal top-level migration runner. Contract therefore cannot be applied accidentally with Expand.

## Rollback and recovery

- **Before/after Expand:** roll the application back freely; all additions are nullable and compatibility triggers supply safe legacy division values. Do not drop additive schema while either app version may use it.
- **During Backfill:** stop invoking batches. Committed batches are safe to retain; resume from remaining counts. App rollback remains safe.
- **Dual-compatible app:** return to the previous compatible application while leaving Expand/backfilled data in place.
- **After Contract:** first apply `migrations/staged/087_d11_crm_source_of_truth_contract_rollback.sql`, which removes strict gates and restores the compatible approver lookup without deleting columns or data; then roll the app back. It does not undo business rows or erase audit history.
- **Restore drill:** restore a sanitized/synthetic dump into PostgreSQL 18, apply through 086, run Expand and batches to zero, validate Contract, exercise tenant/RLS negatives, apply Contract rollback, boot the previous writer, then repeat forward migration. Archive row counts, checksums and exact candidate SHA.

This is a tested migration rollback mechanism, but overall `ROLLBACK_READY` remains conditional until the missing Production source is recovered and the full restore/browser drill runs on the combined candidate.

## Environment parity

[`config/vercel-environment-manifest.json`](../../config/vercel-environment-manifest.json) separates required runtime bindings, conditional integrations, platform-provided/build-generated names and values forbidden in Production. It compares names/scopes only and contains no values. The remote inspection is partial: 100 records were reported, but 76 were omitted by the authorized connector output limit. Missing and ambiguous Production bindings therefore cannot yet be decided.

## Trusted-Candidate manual QA checklist

Run only against a SHA-bound Preview backed by synthetic tenants and an isolated database branch. Record Preview deployment ID, `/api/version` response, operator, UTC start/end, browser and evidence links.

- [ ] Login, session renewal, cross-tab/session expiry and logout; verify cookie flags and no credential leakage.
- [ ] Property Core Editor create/edit/reload, validation, stale-write conflict and division coexistence.
- [ ] Exposé text workspace, rendering and PDF generation/download.
- [ ] Media upload/order/delete, raster rejection and private/public lifecycle.
- [ ] Document Review open/approve/reject and persisted state.
- [ ] Purchase Costs calculation, draft recovery and persisted amounts.
- [ ] Relationship Editor add/change/remove and snapshot consistency.
- [ ] Synthetic CRM read/write using the canonical source; verify no shadow CRM path.
- [ ] `REAL_ESTATE_GROWTH` and `WEB_DESIGN` isolation and cross-division mismatch rejection.
- [ ] Proposal A3: Owner approve/change/reject; non-Owner denied; edited proposal invalidates prior approval; no auto-send or low-value bypass.
- [ ] Contract A3: exact action/version/hash/tenant/resource binding, Owner digest match, replay and non-Owner denial.
- [ ] Audit append/rollback behavior and immutable evidence.
- [ ] RLS authorized read plus cross-tenant read/write, default-deny and role-enforcement negatives.
- [ ] Expand → bounded Backfill → Contract → Contract rollback → previous writer → forward migration.
- [ ] Production build, browser console/network errors, accessibility smoke and all restored Property module regressions.

Manual QA has **not** been executed for U1-C03. It must not start until the combined source tree exists.

## Release gate

Owner approval is prohibited while any of these are unresolved: untruncated Production source recovery, all 43 files reconciled and regression-tested, exact Production env names/scopes exported, exact-SHA CI green, SHA-bound Preview QA complete, and PostgreSQL 18 restore/rollback evidence archived.
